// Интерфейс работы с пакетами
// log - интерфейс для вывода логов
const yaml = require('yaml');
const semver = require('semver');

const importYamlName = 'packages.yaml';

const DEFAULT_DOCHUB_YAML = 
`
$package:
  ".":
    version: 1.0.0
`;

module.exports = function (context) {
    const log = context.log;
    const path = context.path;
    const os = context.os;
    const fs = context.fs;
    const repoAPI = context.repo;
    //const request = context.request;
    const axios = context.axios;

    const SEP = path.sep;

    const packageAPI = {
        installed: {},
        cacheFolder: context.env.cacheFolder,

        beginInstall() {
            this.installed = {};
        },

        endInstall(isCleanCache = true) {
            isCleanCache && this.cleanCache();
        },

        // Полная очистка кэша загрузки
        cleanCache() {
            log.begin('Clean cache...');
            fs.rmSync(this.getCacheFolderFor(), { recursive: true, force: true });
            log.begin('Done.');
        },
        // Очистка кэша для конкретного пакета
        cleanCacheForPackege(packageId) {
            log.begin(`Clean cache for ${packageId}...`);
            fs.rmSync(this.getCacheFolderFor(packageId), { recursive: true, force: true });
            log.begin('Done.');
        },
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
                    const package_ = tree[packageId];
                    if (!package_.in.length) {
                        package_.out.map((outId) => {
                            tree[outId].in = tree[outId].in.filter((element) => element !== packageId);
                        });
                        result.push(package_);
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

        getCacheFolderFor(packageId) {
            const result = packageId
                ? path.resolve(this.cacheFolder, packageId)
                : this.cacheFolder
            return result;
        },

        async downloadAndUnzipFrom(url, packageId) {
            const tmpFolder = await this.getCacheFolderFor(packageId);
            return new Promise((success, reject) => {
                // Если уже скачивали ранее и кэш сохранился используем его
                if (fs.existsSync(tmpFolder)) {
                    log.begin(`Using cache [${tmpFolder}] for [${url}]`);
                    success(tmpFolder);
                    return;
                }
                context.downloader.downloadAndUnzip(url, tmpFolder)
                    .then(success)
                    .catch(reject)
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
            return (packages.find((package_) => package_.metadata[packageId]) || {}).source;
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
            const package_ = packages.find((item) => {
                return item.metadata[packageId];
            });
            return package_ ? {
                source: package_.source,
                metadata: package_.metadata[packageId]
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
            (await this.fetchInstalledPackages(location)).push({
                source,
                metadata
            });

            log.debug(`The package installed to ${destination}`);
            return destination;
        },

        // Устанавливает все зависимости для конкретного пакетаsem
        async allInstall(location) {
            log.begin(`installing dependencies...`);
            const metadata = await packageAPI.getPackageMetadataFromSource(location) || {};
            await packageAPI.resolveDependencies(metadata, path.resolve(location, '_metamodel_'));
            log.end(`Done.`);
        },

        // Проверяем можно ли обновить пакет к указанной версии 
        async isAvailableToUpdate(packageId, toVersion) {
            const result = [];
            for(const location in this.installed) {
                this.installed[location].map((package) => {
                    for (const pkgID in package.metadata || {}) {
                        const metadata = package.metadata[pkgID];
                        const reqVer = (metadata.dependencies || {})[packageId];
                        if (reqVer && !semver.satisfies(toVersion, reqVer) ) {
                            result.push(`Conflict version of dependencies. For ${packageId} required ${toVersion} version, but packege ${pkgID} required ${reqVer} version.`);
                        }
                    }
                });
            }
            return result.length ? result : null;
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
                    if (currentVer) {
                        const conflicts = await this.isAvailableToUpdate(packageId, packageVer);
                        if (conflicts) {
                            conflicts.map(message => log.error(message));
                            throw new Error('Can not resolve dependencies!');
                        }
                        log.debug(`Current version ${currentVer} will be updated to ${packageVer}.`);
                        this.cleanCacheForPackege(packageId);
                        await this.removePackageFrom(location, packageId);
                    }

                    const tempFolder = await packageAPI.downloadAndUnzipFrom(sourcePackage.source, packageId);
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
            const package_ = await this.getPackageMetadata(location, packageId);
            if (package_) {
                fs.rmSync(path.resolve(package_.source), { recursive: true, force: true });
                const index = installed.findIndex((item) => item.source === package_.source);
                if (index >= 0) installed.splice(index, 1);
            } else {
                throw new Error(`Could not remove package ${packageId} from ${package_.source} because it is not found.`);
            }
            log.end(`Done.`);
        }
    };

    return packageAPI;
}