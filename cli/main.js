#!/usr/bin/env node

// https://davidlozzi.com/2021/03/16/style-up-your-console-logs/
// Если часть пакетов поставилась, то их зависимости не разрешаются при установке


const request = require('request');
// const unzipper = require('unzipper');
const tar = require("tar");
var zlib = require('zlib');
const semver = require('semver');

const fs = require('fs');
const os = require('os');
const path = require('path');
const SEP = path.sep;
const yaml = require('yaml');

const REPO_SERVER = new URL(process.env.RACHPKG_REPO_SERVER || 'https://registry.dochub.info/');

const cwd = process.cwd();
const locationCWD = path.resolve(cwd, '_metamodel_');
const importYamlName = 'packages.yaml';

const DEFAULT_DOCHUB_YAML = 
`
$package:
  ".":
    version: 1.0.0
`;


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
    cacheFolder: null,

    beginInstall(params) {
        this.installed = {};
        this.tempFolders = [];
        this.cacheFolder = params.cacheFolder || path.resolve(os.homedir(), '.archpkg');
        log.debug(`Welcome to archpakg!`);
        log.debug(`Using repo server [${REPO_SERVER}]`);
        log.debug(`Cache forlder [${this.cacheFolder}]`);
    },

    endInstall(isCleanCache = true) {
        isCleanCache && this.cleanCache();
    },

    cleanCache() {
        log.begin('Clean cache...');
        fs.rmSync(this.getTempFolderFor(), { recursive: true, force: true });
        log.begin('Done.');
    },

    // Добавляет импорт в файл

    // Строим граф зависимостей по данным из указанной области
    async buildDependenciesGraph(location) {
        log.begin('Building dependencies graph...');
        let result = [];
        const tree = {};
        const installed = await this.fetchInstalledPackages(location);
        // Инициализируем дерево зависимостей
        installed.map((node) => {
            for (const extId in node.metadata) {
                const extention = node.metadata[extId];
                const out = Object.keys(extention.dependencies || {});
                !tree[extId] && (tree[extId] = { id: extId, in: [], out: [] });
                tree[extId].out = tree[extId].out.concat(out);
                out.map((packageId) => {
                    !tree[packageId] && (tree[packageId] = { id: packageId, in: [], out: [] });
                    tree[packageId].in.push(extId);
                });
            }
        });

        // Разбираем дерево зависимостей
        const pullNext = () => {
            const result = [];
            Object.keys(tree).map((packageId) => {
                const package = tree[packageId];
                if (!package.in.length) {
                    package.out.map((outId) => {
                        tree[outId].in = tree[outId].in.filter((element) => element !== packageId);
                    });
                    result.push(package);
                    delete tree[packageId];
                }
            });
            return result;
        };

        let part = null;
        while ((part = pullNext()).length) {
            result = result.concat(part);
        }

        const remainder = Object.keys(tree);
        if (remainder.length > 0)
            throw new Error(`Cyclic dependencies detected. Could not resolve dependencies for [${remainder.join(';')}]`);

        log.end('Done.');
        return result;
    },

    async makeImportsFileByDependenciesGraph(location, graph) {
        const imports = [];
        for (const i in graph) {
            const item = graph[i];
            const source = await this.getSourceOfpackageId(location, item.id);
            if (source) {
                const packageFolder = path.basename(path.dirname((path.resolve(source, 'dochub.yaml'))));
                imports.unshift(`${packageFolder}${path.sep}dochub.yaml`);
            }
        };
        return {
            imports
        };
    },

    // Создает YAML файл подключения пакетов
    async makeImportsYaml(location) {
        log.begin('Building a packages import file...');
        const graph = await this.buildDependenciesGraph(location);
        const imports = await packageAPI.makeImportsFileByDependenciesGraph(location, graph);
        const dochubYaml = new yaml.Document(imports);
        dochubYaml.commentBefore = 'This file is generated automatically by the utility https://www.npmjs.com/package/archpkg.\nIt is not recommended to make changes to it.';
        const filePath = path.resolve(location, importYamlName);
        fs.writeFileSync(filePath, String(dochubYaml), { encoding: 'utf8', flag: 'w' });
        log.debug(`Built ${filePath}`);
        log.end('Done.');
        return filePath;
    },

    // Добавляет зависимость в пакет
    async addDependencyToDochubYaml(source, packageId, version, thisPackage) {
        log.begin('Append dependency...');
        const content = fs.existsSync(source) 
            ? fs.readFileSync(source, { encoding: 'utf8' })
            : DEFAULT_DOCHUB_YAML;
        const yamlFile = yaml.parseDocument(content);
        const data = yamlFile.toJS() || {};
        if (!data.$package) {
            thisPackage = thisPackage || '.';
            log.debug(`No $package entry found. It will be created with package id ${thisPackage}`);
            data.$package = { [thisPackage]: { dependencies: {} } };
            yamlFile.add(yamlFile.createPair('$package', data.$package));
        } else if (!thisPackage) {
            thisPackage = Object.keys(data.$package)[0];
        }

        const currentVersion = (data.$package[thisPackage].dependencies || {})[packageId];
        if (currentVersion !== version) {
            const yaml$package = yamlFile.get('$package');
            const yamlPackageData = yaml$package.get(thisPackage);
            let yamlDependencies = yamlPackageData.get('dependencies');
            if (!yamlDependencies) {
                yamlPackageData.add(yamlFile.createPair('dependencies', {}));
                yamlDependencies = yamlPackageData.get('dependencies');
            }
            if (!currentVersion) {
                yamlDependencies.add(yamlFile.createPair(packageId, version));
            } else {
                yamlDependencies.set(packageId, version);
            }
            fs.writeFileSync(source, String(yamlFile), { encoding: 'utf8', flag: 'w' });
        }

        log.end('Done.');
    },

    // Добавляет импорт в yaml
    async addImportToDochubYaml(source, link) {
        const content = fs.readFileSync(source, { encoding: 'utf8' });
        const yamlFile = yaml.parseDocument(content);
        const data = yamlFile.toJS() || {};
        if ((data.imports || []).indexOf(link) < 0) {
            const imports = yamlFile.get('imports');
            if (imports) {
                imports.add(yamlFile.createNode(link));
            } else {
                yamlFile.add(yamlFile.createPair('imports', [link]));
            }
            fs.writeFileSync(source, String(yamlFile), { encoding: 'utf8', flag: 'w' });
        }
    },

    getTempFolderFor(packageId) {
        const result = packageId
            ? path.resolve(this.cacheFolder, packageId)
            : this.cacheFolder
            packageId && this.tempFolders.push(result);
        return result;
    },

    async downloadAndUnzipFrom(url, packageId) {
        const tmpFolder = await this.getTempFolderFor(packageId);
        return new Promise((success, reject) => {
            // Если уже скачивали ранее и кэш сохранился используем его
            if (fs.existsSync(tmpFolder)) {
                log.begin(`Using cache [${tmpFolder}] for [${url}]`);
                success(tmpFolder);
                return;
            }
            // Создаем временную папку для скачивания
            const tryFolder = `${tmpFolder}__`;
            fs.existsSync(tryFolder)  && fs.rmSync(tryFolder, { recursive: true });
            fs.mkdirSync(tryFolder, { recursive: true });

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
                //.pipe(unzipper.Extract({ path: tmpFolder }))
                .pipe(zlib.createGunzip())
                .pipe(tar.x({
                    strip: 1,
                    C: tryFolder
                  }))
                .on('error', reject)
                .on('close', () => {
                    fs.renameSync(tryFolder, tmpFolder);
                    success(tmpFolder);
                });
        });
    },

    // Возвращает метаданные из указанного размещений
    async getPackageMetadataFromSource(location) {
        const manifest = path.resolve(location, 'dochub.yaml');
        if (!fs.existsSync(manifest))
            throw new Error(`Error of package structure. No found dochub.yaml in ${location}`);
        const content = yaml.parse(fs.readFileSync(manifest, { encoding: 'utf8' }));
        const result = content?.$package;
        if (!result)
            throw new Error(`No available $package metadata of package in ${manifest}`);
        return result;
    },

    // Возвращает ссылку на ресурс, где встречается идентификатор пакета
    async getSourceOfpackageId(location, packageId) {
        const packages = await this.fetchInstalledPackages(location);
        return (packages.find((package) => package.metadata[packageId]) || {}).source;
    },

    // Сканирует пространство на наличие пакетов и возвращает список директорий
    async scanLocation(location) {
        if (!fs.existsSync(location)) return [];
        return fs.readdirSync(location, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    },

    // Получает сведения об установленных пакетах в заданном пространстве
    async fetchInstalledPackages(location) {
        if (this.installed[location]) return this.installed[location];
        log.begin(`Fetch installed packages in ${location}...`);
        const folders = await this.scanLocation(location);
        const result = [];
        for (const index in folders) {
            log.debug(`Scanning ${folders[index]}`);
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

    async getPackageMetadata(location, packageId) {
        const packages = await this.fetchInstalledPackages(location);
        if (!packages) return null;
        const package = packages.find((item) => {
            return item.metadata[packageId];
        });
        return package ? {
            source: package.source,
            metadata: package.metadata[packageId]
        } : null;
    },

    async getInstalledPackageVersion(location, packageId) {
        const metadata = await this.getPackageMetadata(location, packageId);
        return metadata ? metadata.metadata?.version : null;
    },

    async resolveDependencies(metadata, location) {
        for (const extensionId in metadata) {
            const dependencies = metadata[extensionId].dependencies;
            if (dependencies) {
                log.begin(`Install dependencies for [${extensionId}]...`);
                for (const packageId in dependencies) {
                    const version = dependencies[packageId];
                    await this.specificInstall(location, packageId, version);
                }
                log.end('Done.');
            } else log.debug(`Installed extension ${extensionId}`);
        }
    },

    async installPackageTo(from, location, packageId) {
        // const folder = (await this.scanLocation(from))[0];
        const folder = from;
        if (!folder)
            throw new Error(`Structure of the pecked is incorrect in ${from}!`);
        !fs.existsSync(location) && fs.mkdirSync(location, { recursive: true });
        const source = path.resolve(from, folder);
        const metadata = await this.getPackageMetadataFromSource(source) || {};
        // await this.resolveDependencies(metadata, location);
        const destination = path.resolve(location, packageId);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(source, destination, { recursive: true });
        /*
        fs.renameSync(source, destination);
        const toRemoveFolder = this.tempFolders.find((folder) => {
            return source.startsWith(folder);
        });
        toRemoveFolder && fs.rmSync(toRemoveFolder, { recursive: true, force: true });
        */
        (await this.fetchInstalledPackages(location)).push({
            source,
            metadata
        });

        log.debug(`The package installed to ${destination}`);
        return destination;
    },

    // Устанавливает все зависимости для конкретного пакета
    async allInstall(location) {
        log.begin(`installing dependencies...`);
        const metadata = await packageAPI.getPackageMetadataFromSource(location) || {};
        await packageAPI.resolveDependencies(metadata, path.resolve(location, '_metamodel_'));
        log.end(`Done.`);
    },

    // Устанавливает пакет в указанный location (например ./_metamodels_)
    async specificInstall(location, packageId, packageVer) {
        log.begin(`Try to install [${packageId}@${packageVer || 'latest'}]`);
        let result = false;
        const currentVer = await packageAPI.getInstalledPackageVersion(location, packageId);

        if ((currentVer && !packageVer) || semver.satisfies(currentVer, packageVer)) {
            log.success(`Package ${packageId} already installed.`);
            const metadata = await packageAPI.getPackageMetadataFromSource(path.resolve(location, packageId)) || {};
            await packageAPI.resolveDependencies(metadata, location);
            result = currentVer;
        } else {
            const sourcePackage = await repoAPI.fetchSourceOfPackage(packageVer ? `${packageId}@${packageVer}` : packageId);
            result = sourcePackage.version;

            if (sourcePackage.source !== 'built-in') {
                const tempFolder = await packageAPI.downloadAndUnzipFrom(sourcePackage.source, packageId);
                
                if (currentVer) {
                    log.debug(`Current version ${currentVer} will be updated to ${packageVer}.`);
                    await this.removePackageFrom(location, packageId);
                }
    
                await packageAPI.installPackageTo(tempFolder, location, packageId);
                const metadata = await packageAPI.getPackageMetadataFromSource(path.resolve(location, packageId)) || {};
                await packageAPI.resolveDependencies(metadata, location);
            }
        }
        
        log.end(`Done.`);
        return result;
    },


    async removePackageFrom(location, packageId) {
        log.begin(`Try to remove package ${packageId}...`);
        const installed = await this.fetchInstalledPackages(location);
        const package = await this.getPackageMetadata(location, packageId);
        if (package) {
            fs.rmSync(path.resolve(package.source), { recursive: true, force: true });
            const index = installed.findIndex((item) => item.source === package.source);
            if (index >= 0) installed.splice(index, 1);
        } else {
            throw new Error(`Could not remove package ${packageId} from ${package.source} because it is not found.`);
        }
        log.end(`Done.`);
    }
};

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

const commands = {
    async remove(params) {
        const package = params[0];
        if (!package) throw new Error('Package name is required!');
        const packageStruct = package.split('@');
        const packageId = packageStruct[0];
        await packageAPI.removePackageFrom(locationCWD, packageId);
    },

    async install(params) {
        const package = params[0];
        if (!package) {
            await packageAPI.allInstall(cwd);
        } else {
            const packageStruct = package.split('@');
            const packageId = packageStruct[0];
            let packageVer = packageStruct[1];
            packageVer = await packageAPI.specificInstall(path.resolve(cwd, '_metamodel_'), packageId, packageVer);
            packageVer && commandFlags.save
                && await packageAPI.addDependencyToDochubYaml(
                    path.resolve(cwd, 'dochub.yaml'), packageId, packageVer
                );
        }

        const packagesYaml = await packageAPI.makeImportsYaml(locationCWD);

        if (commandFlags.save) {
            await packageAPI.addImportToDochubYaml(path.resolve(cwd, 'dochub.yaml'), `_metamodel_${path.sep}packages.yaml`);
        } else {
            log.success(`\nSuccess!\n\nIMPORTANT: You need to manually specify the import of the ${packagesYaml} file for your project.\nIf you want to add imports automatically, use the "-save" option.\n`);
        }
    },

    async clean() {
        packageAPI.cleanCache();

    }
};

const commandFlags = {
    cleancache: false,      // Признак очистки кэша после установки
    save: false,            // Признак необходимости автоматически подключить пакеты в dochub.yaml
    cachefolder: null       // Корневой путь к кэшу
};  

const run = async () => {
    const params = [];

    process.argv.map((arg) => {
        const struct = arg.split(':');
        let key = struct[0].toLocaleLowerCase();
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

    packageAPI.beginInstall({
        cacheFolder: commandFlags.cachefolder
    });

    const command = params[2];
    const handler = commands[params[2] || '$undefined$'];

    if (!handler) {
        log.error(`Unknown command [${command}]`)
        process.exit(1)
    }

    await handler(params.slice(3));

}

run()
    .catch((error) => {
        log.error(error)
        process.exit(1)
    })
    .finally(() => packageAPI.endInstall(commandFlags.cleancache));
