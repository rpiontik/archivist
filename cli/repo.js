const semver = require('semver');
const { re } = require('semver/internal/re');

module.exports = function (context) {
    const log = context.log;

    const doRequest = function (url) {
        return context.axios.get(url)
        .then((response) => {
            return {
                statusCode: response.status,
                response,
                body: response.data
            };
        })
        .catch((error) => {
            if (error.response) {
                throw new Error(`Request to ${url} failed with code ${error.response.status} and body [${error.response.data}]`);
            } else {
                throw error;
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
                const content = response.body; //JSON.parse(response.body);
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
            const content = response.body; //JSON.parse(response.body);
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