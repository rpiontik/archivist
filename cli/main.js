#!/usr/bin/env node

// https://davidlozzi.com/2021/03/16/style-up-your-console-logs/
// Если часть пакетов поставилась, то их зависимости не разрешаются при установке

const request = require('request');

const path = require('path');

const SSL_CERT = process.env.RACHPKG_SSL_CERT;

const cwd = process.cwd();
const locationCWD = path.resolve(cwd, '_metamodel_');

const log = require('./log')();
const repoAPI = require('./repo')(log, request);
const packageAPI = require('./packages')(log, path, require('os'), require('fs'), repoAPI, request);

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
    cachefolder: null,      // Корневой путь к кэшу
    downloadcert: SSL_CERT || null  // Сертификат для скачивания
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
            commandFlags[key] = struct.slice(1).join(':') || true;
        } else {
            throw new Error(`Unknown command param [${arg}]`);
        }
    });

    packageAPI.beginInstall({
        cacheFolder: commandFlags.cachefolder,
        cert: commandFlags.downloadcert
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
