
const REPO_SERVER = new URL(process.env.RACHPKG_REPO_SERVER || 'https://registry.dochub.info/');

module.exports = function (log, request) {
    const doRequest = function (url) {
        return new Promise(function (resolve, reject) {
            try {
                request(url, function (error, response, body) {
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
    
    
    const repoAPI = {
        env: {
            token: null, // Токен авторизации
            cert: null,  // Токен авторизации
            repoServer: REPO_SERVER
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
        makeGetParams(url) {
            if (this.env.cert) {
                return {
                    method: "GET",
                    uri: url,
                    agentOptions: {
                        ca: this.env.cert
                    }
                };
            } else return url;
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
            return content;
        },
    };
    
    return repoAPI;
}