/*
 * Copyright 2018 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

"use strict";

const path = require("path");
const http = require("http");
const https = require("https");
const util = require("util");

const fse = require("fs-extra");
const pem = require("pem");
const _ = require("lodash");
const { createHttpTerminator } = require("http-terminator");
const {
  error,
  rootLogger,
  FileLogger,
  SimpleInterface,
} = require("@adobe/helix-log");
const app = require("./app");
const git = require("./git");
const { resolveRepositoryPath } = require("./utils");

const DEFAULT_REPO_ROOT = "./repos";
const DEFAULT_HTTP_PORT = 9527;
const DEFAULT_HTTPS_PORT = 5443;
const DEFAULT_HOST = "0.0.0.0";

process.on("uncaughtException", (err) => {
  error("encountered uncaught exception at process level", err);
  // in case of fatal errors which cause process termination errors sometimes don't get logged:
  // => print error directly to console
  /* eslint no-console: off */
  console.log("encountered uncaught exception at process level", err);
});

process.on("unhandledRejection", (reason, p) => {
  error(
    `encountered unhandled promise rejection at process level: ${p}, reason: ${
      reason.stack || reason
    }`
  );
});

/**
 * Current state of the server
 */
const serverState = {
  httpSrv: null,
  httpsSrv: null,
  logger: null,
};

function applyDefaults(options) {
  const opts = options || {};
  opts.repoRoot = opts.repoRoot || DEFAULT_REPO_ROOT;
  opts.virtualRepos = opts.virtualRepos || {};

  opts.listen = opts.listen || {};
  opts.listen.http = _.defaults(opts.listen.http, {
    port: DEFAULT_HTTP_PORT,
    host: DEFAULT_HOST,
  });
  if (opts.listen.https) {
    opts.listen.https = _.defaults(opts.listen.https, {
      port: DEFAULT_HTTPS_PORT,
      host: DEFAULT_HOST,
    });
  }
  return opts;
}

async function initConfiguration(rawConfig) {
  try {
    const config = applyDefaults(rawConfig);

    // root dir of repositories
    config.repoRoot = path.resolve(config.repoRoot);
    await fse.ensureDir(config.repoRoot);

    if (!config.logger) {
      // configure logger
      config.logs = config.logs || {};
      config.logs.logsDir = path.normalize(config.logs.logsDir || "logs");

      await fse.ensureDir(config.logs.logsDir);
      rootLogger.loggers.set(
        // Using a uuid in the name here makes collisions extremely unlikely
        "git-server-errors-6ae5f55e-dbb3-46a0-a596-c238e713c1cc",
        new FileLogger(path.resolve(config.logs.logsDir, "error.log"))
      );
      config.logger = new SimpleInterface({
        level: config.logs.level || "info",
      });
    }
    serverState.logger = config.logger;
    config.logger.debug(
      `configuration successfully read: ${config.configPath}`
    );

    return config;
  } catch (e) {
    throw new Error(`unable to initialize the configuration: ${e.message}`);
  }
}

async function readConfiguration() {
  try {
    let configPath = path.join(__dirname, "config.js");

    const exists = await fse.pathExists(configPath);
    if (!exists) {
      configPath = path.join(process.cwd(), "config.js");
    }

    /* eslint-disable global-require */
    /* eslint-disable import/no-dynamic-require */
    const config = require(configPath);
    config.configPath = configPath;
    return config;
  } catch (e) {
    throw new Error(`unable to read the configuration: ${e.message}`);
  }
}

async function startHttpServer(config) {
  const { host, port } = config.listen.http;

  return new Promise((resolve, reject) => {
    const srv = http
      .createServer(app.createApp(config))
      .listen(port, host, (err) => {
        if (err) {
          reject(
            new Error(`unable to start start http server: ${err.message}`)
          );
        } else {
          config.logger.info(
            `[${process.pid}] HTTP: listening on port ${srv.address().port}`
          );
          resolve(srv);
        }
      });
  });
}

async function startHttpsServer(config) {
  const { host, port, key, cert } = config.listen.https;

  const createCertificate = util.promisify(pem.createCertificate);

  try {
    let options;
    if (key && cert) {
      debugger;
      options = {
        key: await fse.readFile(key, "utf8"),
        cert: await fse.readFile(cert, "utf8"),
      };
    } else {
      debugger;
      const keys = await createCertificate({ selfSigned: true });
      options = {
        key: keys.serviceKey,
        cert: keys.certificate,
      };
    }

    return new Promise((resolve, reject) => {
      const srv = https
        .createServer(options, app(config))
        .listen(port, host, (err) => {
          if (err) {
            reject(
              new Error(`unable to start start https server: ${err.message}`)
            );
          } else {
            config.logger.info(
              `[${process.pid}] HTTPS: listening on port ${srv.address().port}`
            );
            resolve(srv);
          }
        });
    });
  } catch (e) {
    throw new Error(`unable to start start https server: ${e.message}`);
  }
}

async function stopServer({ server, terminator, protocol, logger }) {
  if (!server || !terminator) {
    return;
  }
  try {
    await terminator.terminate();
  } catch (err) {
    throw new Error(`Error while stopping ${protocol} server: ${err}`);
  }
  logger.info(`${protocol}: server stopped.`);
}

async function createRouter(rawConfig) {
  const cfg = rawConfig || (await readConfiguration());
  return app.createRouter(await initConfiguration(cfg));
}

async function start(rawConfig) {
  const cfg = rawConfig || (await readConfiguration());
  return (
    initConfiguration(cfg)
      // setup and start the server
      .then(async (config) => {
        let server = await startHttpServer(config);
        serverState.http = {
          server,
          terminator: createHttpTerminator({ server }),
        };
        // issue #218: https is optional
        if (config.listen.https) {
          server = await startHttpsServer(config);
          serverState.https = {
            server,
            terminator: createHttpTerminator({ server }),
          };
        }
        return {
          httpPort: serverState.http.server.address().port,
          httpsPort: serverState.https
            ? serverState.https.server.address().port
            : -1,
        };
      })
      // handle errors during initialization
      .catch((err) => {
        const msg = `error during startup, exiting... : ${err.message}`;
        serverState.logger.error(msg);
        throw Error(msg);
      })
  );
}

async function getRepoInfo(rawConfig, owner, repo) {
  const cfg = rawConfig || (await readConfiguration());
  const repPath = resolveRepositoryPath(
    await initConfiguration(cfg),
    owner,
    repo
  );
  const currentBranch = await git.currentBranch(repPath);
  return { owner, repo, currentBranch };
}

async function stop() {
  const { logger } = serverState;
  if (serverState.http) {
    await stopServer({ ...serverState.http, logger, protocol: "http" });
    delete serverState.http;
  }
  if (serverState.https) {
    await stopServer({ ...serverState.https, logger, protocol: "https" });
    delete serverState.https;
  }
}

module.exports = {
  start,
  stop,
  getRepoInfo,
  createRouter,
};
