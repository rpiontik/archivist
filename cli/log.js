
module.exports = function () {
    return {
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
}