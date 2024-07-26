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
                
                //const source = context.axios.CancelToken.source();
                
                context.axios({
                    method: 'get',
                    url: this.makeDownloadParams(url),
                    responseType: 'stream',
                    //cancelToken: source.token
                })
                    .then((response) => {
                        totalBytes = parseInt(response.headers['content-length']);
                        if (response.status === 404)
                            reject(`Package unavailable on URL ${url}`);
                        if ((response.status < 200) || response.status > 300)
                            reject(`Error of downloading package from [${url}]. Response with code ${response.status}.`);
                        log.progressBegin();

                        const stream = response.data;
                        stream.on('data', (chunk) => {
                            receivedBytes += chunk.length;
                            log.progress(receivedBytes, totalBytes);
                        });
                        stream.on('end', () => {
                            log.progressEnd();
                            log.end('Done.');
                        });
                        stream.on('error', reject);

                        stream.pipe(zlib.createGunzip())
                            .pipe(tar.x({
                                strip: 1,
                                C: tryFolder
                            }))
                            .on('error', reject)
                            .on('close', () => {
                                fs.renameSync(tryFolder, tmpFolder);
                                success(tmpFolder);
                            });
                    })
                    .catch((error) => {
                        if (context.axios.isCancel(error)) {
                            log.end('Canceled.');
                        } else {
                            reject(error);
                        }
                    });
            });
        }
    }
}