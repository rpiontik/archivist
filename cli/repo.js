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
                guestToken: '/session/guest/token'
            },
            repo: {
                download: '/repo/download/',
                metadata: '/repo/metadata/'
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
        async fetchReleasesByOwnerRepoVer(owner, repo, version) {
            const fetchURL = this.makeURL(`https://api.github.com/repos/${owner}/${repo}/releases`).toString();
            log.begin(`Try to get fetch releases from ${fetchURL} for version [${version ? version : 'any'}]...`);
            const response = await doRequest({
                url: fetchURL,
                headers: {
                    'User-Agent': 'archpkg',
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });
            const content = JSON.parse(response.body);
            const versions = content.filter((item) => {
                return !version || semver.satisfies(item.tag_name, version) || semver.satisfies(item.tag_name.slice(1), version);
            }).sort((v1, v2) => {
                const strvToNumber = function (rel) {
                    const struct = rel.tag_name.toString().replace('v', '').split('.');
                    const result = 
                        Number.parseInt(struct[0] || '0') * 1000000000 
                        + Number.parseInt(struct[1] || '0') * 1000000
                        + Number.parseInt(struct[2] || '0') * 1000;
                    return result;
                };
                return strvToNumber(v1) - strvToNumber(v2);
            });
            log.end(`Found versions: ${versions.map(item => item.tag_name).join(', ')}.`);
            return versions;
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
            if (content.repo === '$built-in$') {
                log.end(`The package is built-in.`);
                return {
                    source: 'built-in'
                }    
            }
            log.debug(`Owner: ${content.owner}, Repo: ${content.repo}`);
            const releases = await this.fetchReleasesByOwnerRepoVer(content.owner, content.repo, package.split('@')[1]);
            if (!releases || !releases.length)
                throw new Error(`No found any release for ${$package}!`);
            const release = releases.pop();
            const result = {
                package,
                'source': `https://codeload.github.com/${content.owner}/${content.repo}/tar.gz/refs/tags/${release.tag_name}`
            };
            log.end(`Link is found: ${result.source}`); 
            return result;
        },
    };
}