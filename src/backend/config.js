import dotenv from 'dotenv';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
const initialLoad = dotenv.config({ path: envPath });

if (initialLoad.error && initialLoad.error.code !== 'ENOENT') {
    throw initialLoad.error;
}

let loadedValues = new Map(Object.entries(initialLoad.parsed ?? {}));

function reloadEnvironment(contents) {
    const parsed = dotenv.parse(contents);

    for (const [key, value] of loadedValues) {
        if (!(key in parsed) && process.env[key] === value) delete process.env[key];
    }
    for (const [key, value] of Object.entries(parsed)) process.env[key] = value;

    loadedValues = new Map(Object.entries(parsed));
}

export { envPath, reloadEnvironment };
