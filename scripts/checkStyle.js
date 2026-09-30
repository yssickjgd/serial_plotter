const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const directories = [root, path.join(root, 'tests'), __dirname];
let failures = 0;

for (const directory of directories) {
    for (const name of fs.readdirSync(directory).filter(file => file.endsWith('.js'))) {
        const file = path.join(directory, name);
        const source = fs.readFileSync(file, 'utf8');
        const label = path.relative(root, file);
        try {
            new vm.Script(source, { filename: file });
        } catch (error) {
            process.stderr.write(`${label}: ${error.message}\n`);
            failures++;
        }
        if (/\t/.test(source) || /[ \t]+(?=\r?$)/m.test(source) || !source.endsWith('\n')) {
            process.stderr.write(`${label}: tabs, trailing spaces, or missing final newline\n`);
            failures++;
        }
    }
}

if (failures) process.exitCode = 1;
else process.stdout.write('JavaScript syntax and whitespace checks passed.\n');
