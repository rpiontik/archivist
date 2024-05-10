const zlib = require('zlib');
const tar = require("tar");

// Реализует функцию загрузки и распаковки пакетов
module.exports = function (context) {
    const fs = context.fs;
    const log = context.log;

    return {
        makeDownloadParams(url, method = 'GET') {
            if (context.env.downloadCert) {
                return {
                    method,
                    url,
                    agentOptions: {
                        ca: context.env.downloadCert
                    }
                };
            } else return url;
        },

        async downloadAndUnzip(url, tmpFolder) {
            return new Promise((success, reject) => {
                // Создаем временную папку для скачивания
                const tryFolder = `${tmpFolder}__`;
                fs.existsSync(tryFolder) && fs.rmSync(tryFolder, { recursive: true });
                fs.mkdirSync(tryFolder, { recursive: true });

                log.begin(`Downloading ${url}...`);
                let totalBytes = 0;
                let receivedBytes = 0;
                
                context.request(this.makeDownloadParams(url))
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
        }
    }
}