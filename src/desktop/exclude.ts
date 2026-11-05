import { defaultIgnore } from '../adapters/local';

/** Patterns match a name, not a path: `*` and `?` are wildcards, a trailing `/` limits it to folders. */
export function makeIgnore(patterns: string[]): (name: string, isDir: boolean) => boolean {
    const rules = patterns.map((p) => {
        const dirOnly = p.endsWith('/');
        const body = (dirOnly ? p.slice(0, -1) : p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
        return { dirOnly, re: new RegExp(`^${body}$`) };
    });
    return (name, isDir) => defaultIgnore(name, isDir) || rules.some((r) => (!r.dirOnly || isDir) && r.re.test(name));
}
