const semver = require('semver');

module.exports = function (context) {
    const log = context.log;

    const doRequest = function (url) {
        return new Promise(function (resolve, reject) {
            try {
                context.request(url, function (error, response, body) {
                    if (!error && (response.statusCode >= 200) && response.statusCode < 300) {
                        resolve({
                            statusCode: response.statusCode,
                            response,
                            body
                        });
                    } else {
                        reject(error || `Request to ${url} failed with code ${response.statusCode} and body [${body}]`);
                    }
                });
            } catch (error) {
                reject(error || `Request to ${url} failed.`);
            }
        });
    }
    
    return {
        env: {
            token: null // Токен авторизации
        },
        routes: {
            access: {
                guestToken: 'api/session/guest/token'
            },
            repo: {
                metadata: 'api/repo/v2/metadata/'
            }
        },
        makeURL(route) {
            return new URL(route, context.env.repoServer);
        },
        async getAccess() {
            if (!this.env.token) {
                log.begin('Try to get access to repo...');
                const response = await doRequest(
                        this.makeURL(this.routes.access.guestToken).toString()
                );
                const code = response && response.statusCode;
                if (response && code !== 201) {
                    throw new Error(`Error server response with code ${code} and body [${response.body}]`);
                }
                const content = JSON.parse(response.body);
                this.env.token = content.token;
                log.end(`Access token provided: ${content.token}`);
            }
        },
        async fetchSourceOfPackage(package) {
            await this.getAccess();
            const url = this.makeURL(`${this.routes.repo.metadata}${package}`).toString();
            log.begin(`Try to get link of package [${package}]...`);
            const response = await doRequest(url, {
                auth: {
                    bearer: this.env.token
                }
            });
            if (response.statusCode !== 200)
                throw new Error(`Error of resolve the download link of package ${package}. Response code ${response.statusCode} with body [${response.body}]`);
            const content = JSON.parse(response.body);
            if (content.type === 'built-in') {
                log.end(`The package is built-in.`);
                return {
                    source: 'built-in'
                }    
            } else {
                log.end(`Link is found: ${content.source}`); 
                return content;
            }
        },
    };
}