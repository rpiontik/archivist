#!/usr/bin/env node

// https://davidlozzi.com/2021/03/16/style-up-your-console-logs/
// Если часть пакетов поставилась, то их зависимости не разрешаются при установке

const path = require('path');
const fs = require('fs');
const os = require('os');


const SSL_CERT = process.env.RACHPKG_SSL_CERT;

const cwd = process.cwd();
const locationCWD = path.resolve(cwd, '_metamodel_');

const log = require('./log')();

// Формируем контекст работы пакетного менеджера
const context = {
    env : {                         // Перемнные среды для archpkg
        cacheFolder:                // Пространство для создания кэшей
            process.env.ARCHPKG_CACHE_FOLDER
            || path.resolve(os.homedir(), '.archpkg'),
        repoServer: new URL(        // Адрес сервера индекса пакетов
            process.env.ARCHPKG_REPO_SERVER || 'https://registry.dochub.info/'
        ),
        downloadCert:               // Ссылка на SSL сертификат для скачивания 
            process.env.ARCHPKG_DOWNLOAD_CERT || null
    },
    request: require('request'),    // Реализация запросов web-запросов 
    log: require('./log')(),        // Реализация системы логирования
    path,                           // Работа с путями
    fs,                             // Функции файловой системы
    downloader: null,               // Функции загрузки пакетов
    repo: null,                     // Функции archpkg репозитория
    manager: null                   // Функции пакетного менеджера    
};
context.downloader = require('./downloader')(context);
context.repo = require('./repo')(context);
context.manager = require('./packages')(context);

const commands = {
    async remove(params) {
        const package = params[0];
        if (!package) throw new Error('Package name is required!');
        const packageStruct = package.split('@');
        const packageId = packageStruct[0];
        await context.manager.removePackageFrom(locationCWD, packageId);
    },

    async install(params) {
        const package = params[0];
        if (!package) {
            await context.manager.allInstall(cwd);
        } else {
            const packageStruct = package.split('@');
            const packageId = packageStruct[0];
            let packageVer = packageStruct[1];
            packageVer = await context.manager.specificInstall(path.resolve(cwd, '_metamodel_'), packageId, packageVer);
            packageVer && commandFlags.save
                && await context.manager.addDependencyToDochubYaml(
                    path.resolve(cwd, 'dochub.yaml'), packageId, packageVer
                );
        }

        const packagesYaml = await context.manager.makeImportsYaml(locationCWD);

        if (commandFlags.save) {
            await context.manager.addImportToDochubYaml(path.resolve(cwd, 'dochub.yaml'), `_metamodel_${path.sep}packages.yaml`);
        } else {
            log.success(`\nSuccess!\n\nIMPORTANT: You need to manually specify the import of the ${packagesYaml} file for your project.\nIf you want to add imports automatically, use the "-save" option.\n`);
        }
    },

    async clean() {
        context.manager.cleanCache();
    }
};

const commandFlags = {
    cleancache: false,      // Признак очистки кэша после установки
    save: false,            // Признак необходимости автоматически подключить пакеты в dochub.yaml
    cachefolder: null,      // Корневой путь к кэшу
    downloadcert: SSL_CERT || null  // Сертификат для скачивания
};  

const run = async () => {
    context.log.debug(`Welcome to archpakg!`);
    log.debug(`Using repo server [${context.env.repoServer}]`);
    log.debug(`Cache forlder [${context.env.cacheFolder}]`);

    const params = [];

    // Разбираем параметры запуска
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

    // Если явно указана папка кэширования, устанавливаем ее
    context.env.cacheFolder = commandFlags.cachefolder || context.env.cacheFolder;

    // Если указан сертификат для скачивания, устанавливаем его
    context.env.downloadCert = commandFlags.downloadcert || context.env.downloadCert;

    // Если используется собственный сертификат для скачивания - загружаем
    if (context.env.downloadCert) {
        context.log.debug(`Will use sslcert [${context.env.downloadCert}]`);
        // Загружаем сертификат
        context.env.downloadCert = context.fs.readFileSync(context.env.downloadCert);
    }

    // Запускаем установку
    context.manager.beginInstall();

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
    .finally(() => context.manager.endInstall(commandFlags.cleancache));
