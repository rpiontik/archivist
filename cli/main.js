#!/usr/bin/env node

// https://davidlozzi.com/2021/03/16/style-up-your-console-logs/
// Если часть пакетов поставилась, то их зависимости не разрешаются при установке


const request = require('request');
const unzipper = require('unzipper');
const semver = require('semver');

const fs = require('fs');
const os = require('os');
const path = require('path');
const SEP = path.sep;
const yaml = require('yaml');

const REPO_SERVER = new URL('http://localhost:3000');

const cwd = process.cwd();
const locationCWD = path.resolve(cwd, '_metamodels_');


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
    tempFolders: [],

    beginInstall() {
        this.installed = {};
        this.tempFolders = [];
    },

    endInstall(isCleanCache = true) {
        isCleanCache && this.cleanCache();
    },

    cleanCache() {
        log.begin('Clean cache...');
        this.tempFolders.map((folder) => {
            try {
                fs.rmSync(folder, { recursive: true, force: true });
            } catch (err) {
                log.error(`Could not remove [${folder}] with error ${err.toString()} `);
            }
        });
        log.begin('Done.');
    },

    getHashOf(str, seed = 0) {
        let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for(let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1  = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2  = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    },

    getTempFolderFor(url) {
        const result = url
            ? path.resolve(os.tmpdir(), 'archpkg', `${this.getHashOf(url)}`)
            : fs.mkdtempSync(path.resolve(os.tmpdir(), `archpkg-`));
        this.tempFolders.push(result);
        return result;
    },

    async downloadAndUnzipFrom(url) {
        const tmpFolder = await this.getTempFolderFor(url);
        return new Promise((success, reject) => {
            // Если уже скачивали ранее и кэш сохранился используем его
            if (fs.existsSync(tmpFolder)) {
                log.begin(`Using cache [${tmpFolder}] for [${url}]`);
                success(tmpFolder);
                return;
            }
            log.begin(`Downloading ${url}...`);
            let totalBytes = 0;
            let receivedBytes = 0;
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
        const package = packages.find((item) => {
            return item.metadata[packageID];
        });
        return package ? {
            source: package.source,
            metadata: package.metadata[packageID]
        } : null;
    },

    async getInstalledPackageVersion(location, packageID) {
        const metadata = await this.getPackageMetadata(location, packageID);
        return metadata ? metadata.metadata?.version : null;
    },

    async resolveDependencies(metadata, location) {
        for (const extentionId in metadata) {
            const dependencies = metadata[extentionId].dependencies;
            if (dependencies) {
                log.begin(`Install dependencies for ${extentionId}...`);
                for (const packageId in dependencies) {
                    const version = dependencies[packageId];
                    await commands.install([`${packageId}@${version}`], location);
                }
                log.end('Done.');
            } else log.debug(`Installed extension ${extentionId}`);
        }
    },

    async installPackageTo(from, location, packageId) {
        const folder = (fs.readdirSync(from) || [])[0];
        if (!folder)
            throw new Error('Structure of the pecked is incorrect!');
        !fs.existsSync(location) && fs.mkdirSync(location, { recursive: true });
        const source = path.resolve(from, folder);
        const metadata = await this.getPackageMetadataFromSource(source) || {};
        this.resolveDependencies(metadata, location);
        const distanation = path.resolve(location, packageId);
        fs.rmSync(distanation, { recursive: true, force: true });
        fs.renameSync(source, distanation);
        const toRemoveFolder = this.tempFolders.find((folder) => {
            return source.startsWith(folder);
        });
        toRemoveFolder && fs.rmSync(toRemoveFolder, { recursive: true, force: true });
        log.debug(`The package intalled to ${distanation}`);
        return distanation;
    },

    async removePackageFrom(location, packageId) {
        log.begin(`Try to remove package ${packageId}...`);
        const installed = await this.fetchInstalledPackages(location);
        const package = await this.getPackageMetadata(location, packageId);
        if (package) {
            fs.rmSync(path.resolve(package.source), { recursive: true, force: true });
        } else {
            throw new Error(`Could not remove package ${packageId} from ${package.source} because it is not found.`);
        }
        log.end(`Done.`);
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
                reject(error || `Request to ${url} failed with code ${response.statusCode} and body [${body}]`);
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

const commands = {
    async remove(params) {
        const package = params[0];
        if (!package) throw new Error('Package name is required!');
        const packageStruct = package.split('@');
        const packageID = packageStruct[0];
        await packageAPI.removePackageFrom(locationCWD, packageID);
    },

    async install(params, location) {
        const package = params[0];
        if (!package) {
            log.begin(`installing dependencies...`);
            const metadata = await packageAPI.getPackageMetadataFromSource(cwd) || {};
            await packageAPI.resolveDependencies(metadata, locationCWD);
            log.begin('done');
        } else {
            log.begin(`Try to install [${package}]`);
            const packageStruct = package.split('@');
            const packageID = packageStruct[0];
            const packageVer = packageStruct[1];
            const targetLocation = location || locationCWD;
            const currentVer = await packageAPI.getInstalledPackageVersion(targetLocation, packageID);

            if ((currentVer && !packageVer) || semver.satisfies(currentVer, packageVer)) {
                log.success(`Package ${packageID} alrady installed.`);
                const metadata = await packageAPI.getPackageMetadataFromSource(path.resolve(targetLocation, packageID)) || {};
                await packageAPI.resolveDependencies(metadata, locationCWD);
            } else {
                if (currentVer) {
                    log.debug(`Current version ${currentVer} will be updated to ${packageVer}.`);
                    await commands.remove([packageID]);
                }
                const linkToPackage = await repoAPI.getLinkToPackage(package);

                if (linkToPackage !== 'built-in') {
                    const tempFolder = await packageAPI.downloadAndUnzipFrom(linkToPackage);
                    await packageAPI.installPackageTo(tempFolder, location || locationCWD, packageID);
                }
            }

            log.end(`Done.`);
        }
    }
};

const commandFlags = {
    nocleancache: false // Не очищать кэш скачанных пакетов после установки 
};

const run = async () => {

    const params = [];

    process.argv.map((arg) => {
        const struct = arg.split(':');
        let key = struct[0];
        if (key.slice(0, 1) !== '-') {
            params.push(arg);
            return;
        } 
        key = key.slice(1);
        if (commandFlags[key] !== undefined) {
            commandFlags[key] = struct[1] || true;
        } else {
            throw new Error(`Unknown command param [${arg}]`);
        }
    });

    const command = params[2];
    const handler = commands[params[2] || '$undefined$'];

    if (!handler) {
        log.error(`Unknown command [${command}]`)
        process.exit(1)
    }
    
    await handler(params.slice(3));
}

packageAPI.beginInstall();

run()
.catch((error) => {
    log.error(error)
    process.exit(1)
}).finally(() => packageAPI.endInstall(!commandFlags.nocleancache));
