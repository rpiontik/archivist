#!/usr/bin/env node

const run = () => {
    console.info('Hello world!');
}

try {
    run()
} catch (err) {
    console.error()
    console.error(err)
    process.exit(1)
}