#!/usr/bin/env node

// https://davidlozzi.com/2021/03/16/style-up-your-console-logs/

const request = require('request');
const unzip = require('unzip');

const REPO_SERVER = new URL('http://localhost:3000');

const doRequest = function (url) {
    return new Promise(function (resolve, reject) {
      request(url, function (error, response, body) {
        if (!error && (response.statusCode >= 200) && response.statusCode < 300) {
          resolve({
            statusCode: response.statusCode,
            response,
            body
          });
        } else {
          reject(error || `Response with code ${response.statusCode} and body [${body}]`);
        }
      });
    });
  }

const log = {
    level: 0,
    begin(info) {
        console.log(this.getMargin(), info);
        this.level++;
    },
    end(info) {
        console.info(this.getMargin(), '\x1b[32m', info, '\x1b[0m');
        this.level && this.level--;
    },
    getMargin() {
        return "||||||||||||||||||||||||||||||||||||||||||||||||||||||||".slice(0, this.level) + '-';
    },
    debug(info) {
        console.log(this.getMargin(), info);
    },
    error(info) {
        console.error(this.getMargin(), '\x1b[31m', info, '\x1b[0m');
    },
    success(info) {
        console.info(this.getMargin(), '\x1b[32m', info, '\x1b[0m');
    }
};

const API = {
    env: {
        token: null // Токен авторизации
    },
    routes: {
        access: {
            guestToken: '/session/guest/token'
        },
        repo: {
            download: '/repo/download/'
        }
    },
    makeURL(route) {
        return new URL(route, REPO_SERVER);
    },
    async getAccess() {
        if (!this.env.token) {
            log.begin('Try to get access to repo...');
            const response = await doRequest(this.makeURL(this.routes.access.guestToken).toString());
            const code = response && response.statusCode;
            if (response && code !==201) {
                throw new Error(`Error server response with code ${code} and body [${response.body}]`);
            }
            const content = JSON.parse(response.body);
            this.env.token = content.token;
            log.end(`Access token provided: ${content.token}`);
        }
    },
    async getLinkToPackage(package) {
        log.begin(`Downloading package ${package}...`);
        await this.getAccess();
        const url = this.makeURL(`${this.routes.repo.download}${package}`).toString();
        log.begin(`Try to get link of package...`);
        const response = await doRequest(url, {
            auth: {
                bearer: this.env.token
            }
        });
        if (response.statusCode !== 200)
            throw new Error(`Error of resolve the download link of package ${package}. Response code ${response.statusCode} with body [${response.body}]`);
        const content = JSON.parse(response.body);
        log.end(`Link is found: ${content.source}`);
        request(content.source).pipe(unzip.Extract({ path: './out/' }));
        log.end('Done.');
    }
};

const run = async() => {
    const command = process.argv[2];

    const commands = {
        async install(params) {
            const package = params[0];
            if (!package) throw new Error('Package name is required!');
            log.begin(`Try to instal [${package}]`);
            const linkToPackage = await API.getLinkToPackage(package);
        }
    };
    
    const handler = commands[process.argv[2] || '$undefined$'];
    
    if (!handler) {
        log.error(`Unknown command [${command}]`)
        process.exit(1)
    }
    
    await handler(process.argv.slice(3));
}

run().catch((error) => {
    log.error(error)
    process.exit(1)
});

