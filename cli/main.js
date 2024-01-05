#!/usr/bin/env node

// https://davidlozzi.com/2021/03/16/style-up-your-console-logs/

const request = require('request');
const unzipper = require('unzipper');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SEP = path.sep;
const yaml = require('yaml');

const REPO_SERVER = new URL('http://localhost:3000');

const locationCWD = path.resolve(process.cwd(), '_metamodels_');


const log = {
    level: 0,
    begin(info) {
        console.log(this.getMargin(), info);
        this.level++;
    },
    end(info) {
        console.info(this.getMargin(), `\x1b[32m${info}\x1b[0m`);
        this.level && this.level--;
    },
    getMargin() {
        return "||||||||||||||||||||||||||||||||||||||||||||||||||||||||".slice(0, this.level) + '-';
    },
    debug(info) {
        console.log(this.getMargin(), info);
    },
    error(info) {
        console.error(this.getMargin(), `\x1b[31m${info}\x1b[0m`);
    },
    success(info) {
        console.info(this.getMargin(), `\x1b[32m${info}\x1b[0m`);
    },
    progressBegin() {
    },
    progress(value, total) {
        if (total) {
            const percentage = ((value * 100) / total).toFixed(2);
            process.stdout.write(`\r${this.getMargin()} [${percentage}%] ${value}  bytes out of ${total}  bytes.`);
        } else {
            process.stdout.write(`\r${this.getMargin()} Recieved ${value} bytes.`);
        }
    },
    progressEnd() {
        process.stdout.write('\r\n');
    },
};


const packageAPI = {
    installed: {},
    getTempFolder() {
        return new Promise((success, reject) => {
            fs.mkdtemp(`${os.tmpdir()}${SEP}archpkg-`, (err, folder) => {
                if (err) reject(err);
                else success(folder);
            });
        });
    },
    async downloadAndUnzipFrom(url) {
        const tmpFolder = await this.getTempFolder();
        return new Promise((success, reject) => {
            log.begin(`Downloading ${url}...`);
            let totalBytes = 0;
            let receivedBytes = 0;
            // success('/tmp/archpkg-WqheRm/');
            request(url)
                .on('response', (data) => {
                    totalBytes = parseInt(data.headers['content-length']);
                    if (data.statusCode === 404) 
                        reject(`Package unavailable on URL ${url}`);
                    if ((data.statusCode < 200) || data.statusCode > 300)
                        reject(`Error of downloading package from [${url}]. Response with code ${data.statusCode}.`);
                    log.progressBegin();
                })
                .on('data', (chunk) => {
                    receivedBytes += chunk.length;
                    log.progress(receivedBytes, totalBytes);
                })
                .on('end', (chunk) => {
                    log.progressEnd();
                    log.end('Done.');
                })
                .on('error', reject)
                .pipe(unzipper.Extract({ path: tmpFolder }))
                .on('error', reject)
                .on('close', () => {
                    success(tmpFolder);
                });
        });
    },
    async getPackageMetadataFromSource(dir) {
        const manifest = path.resolve(dir, 'dochub.yaml');
        if (!fs.existsSync(manifest))
            throw new Error(`Error of package structure. No found dochub.yaml in ${dir}`);
        const content = yaml.parse(fs.readFileSync(manifest, { encoding: 'utf8' }));
        const result = content?.$package;
        if (!result) 
            throw new Error(`No available $package metadata of package in ${path.resolve(dir, 'dochub.yaml')}`);
        return result;
    },
    async fetchInstalledPackages(location) {
        if (this.installed[location]) return this.installed[location];
        log.begin(`Fetch installed packages in ${location}...`);
        const folders = (fs.readdirSync(location) || []);
        const result = [];
        for (const index in folders) {
            log.debug(`Scaning ${folders[index]}`);
            const source = path.resolve(location, folders[index]);
            const metadata = await this.getPackageMetadataFromSource(source);
            result.push(
                { 
                    source,
                    metadata
                }
            );

        }
        log.end('Done.');
        return this.installed[location] = result;
    },
    async getPackageMetadata(location, packageID) {
        const packages = await this.fetchInstalledPackages(location);
        if (!packages) return null;
        return packages.find((item) => {
            return item.metadata[packageID];
        })?.metadata[packageID];
    },
    async getInstalledPackageVersion(location, packageID) {
        const metadata = await this.getPackageMetadata(location, packageID);
        return metadata ? metadata.version : null;
    },
    async installPackageTo(from, location, packageId) {
        const folder = (fs.readdirSync(from) || [])[0];
        if (!folder) 
            throw new Error('Structure of the pecked is incorrect!');
        !fs.existsSync(location) && fs.mkdirSync(location, { recursive: true });
        const source = path.resolve(from, folder);
        const metadata = await this.getPackageMetadataFromSource(source);

        const distanation = path.resolve(location, packageId);
        fs.renameSync(source, distanation);
        // fs.rmSync(from, { recursive: true, force: true } ); // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
        log.debug(`The package move to ${distanation}`);
        return distanation;
    },
    async isInstalledPackage(location, packageId, packageVer) {

    }
};

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


const repoAPI = {
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
            if (response && code !== 201) {
                throw new Error(`Error server response with code ${code} and body [${response.body}]`);
            }
            const content = JSON.parse(response.body);
            this.env.token = content.token;
            log.end(`Access token provided: ${content.token}`);
        }
    },
    async getLinkToPackage(package) {
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
        return content.source;
    },
};

const run = async () => {
    const command = process.argv[2];

    const commands = {
        async install(params) {
            const package = params[0];
            if (!package) throw new Error('Package name is required!');

            const packageStruct = package.split('@');
            const packageID = packageStruct[0];
            const packageVer = packageStruct[1];
            const currentVer = await packageAPI.getInstalledPackageVersion(locationCWD, packageID);

            console.info('>>>>>>>>>>>>>>> CV', currentVer);

            log.begin(`Try to install [${package}]`);
            const linkToPackage = await repoAPI.getLinkToPackage(package);
            const tempFolder = await packageAPI.downloadAndUnzipFrom(linkToPackage);
            console.info('>>>>', tempFolder);
            packageAPI.installPackageTo(tempFolder, locationCWD, packageID);

            log.end(`Done.`);
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
