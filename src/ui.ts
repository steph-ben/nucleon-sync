// Terminal look: colours, symbols, a banner and a spinner. All of it turns itself off when the output is not a terminal
// (a pipe, a log file, CI) or when NO_COLOR is set, so scripts and tests only ever see plain text.

const fancy = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (fancy() ? `\x1b[${code}m${text}\x1b[0m` : text);

export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

/** A leading symbol, or a plain ASCII mark when the output is not a terminal. */
export const mark = {
    ask: () => (fancy() ? cyan('?') : '?'),
    ok: () => (fancy() ? green('✔') : '+'),
    warn: () => (fancy() ? yellow('!') : '!'),
    fail: () => (fancy() ? red('✘') : 'x'),
};

export function banner(): string[] {
    return [
        '',
        `  ${cyan('╭───────╮')}     ${yellow('╭───────╮')}`,
        `  ${cyan('│ FILES │')} ${bold('⇄⇄⇄')} ${yellow('│ DRIVE │')}     ${bold('nucleon-sync')}`,
        `  ${cyan('╰───────╯')}     ${yellow('╰───────╯')}     ${dim('two-way sync for Proton Drive · unofficial')}`,
        '',
    ];
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A line with a spinner and the seconds spent, while something slow runs. Plain text in a pipe. */
export async function working<T>(label: string, task: () => Promise<T>, done?: (result: T) => string): Promise<T> {
    if (!fancy()) {
        console.log(`${label}...`);
        return task();
    }
    const started = Date.now();
    let frame = 0;
    const draw = () => process.stdout.write(`\r\x1b[2K  ${cyan(FRAMES[frame++ % FRAMES.length]!)} ${label} ${dim(`${Math.floor((Date.now() - started) / 1000)}s`)}`);
    draw();
    const timer = setInterval(draw, 80);
    try {
        const result = await task();
        clearInterval(timer);
        process.stdout.write(`\r\x1b[2K  ${mark.ok()} ${done ? done(result) : label} ${dim(`${Math.floor((Date.now() - started) / 1000)}s`)}\n`);
        return result;
    } catch (e) {
        clearInterval(timer);
        process.stdout.write(`\r\x1b[2K  ${mark.fail()} ${label}\n`);
        throw e;
    }
}

/** Shows a waiting line (no end known) and returns a function that clears it. */
export function waiting(label: string): () => void {
    if (!fancy()) {
        console.log(`${label}...`);
        return () => {};
    }
    const started = Date.now();
    let frame = 0;
    const draw = () => process.stdout.write(`\r\x1b[2K  ${cyan(FRAMES[frame++ % FRAMES.length]!)} ${label} ${dim(`${Math.floor((Date.now() - started) / 1000)}s`)}`);
    draw();
    const timer = setInterval(draw, 80);
    return () => {
        clearInterval(timer);
        process.stdout.write(`\r\x1b[2K  ${mark.ok()} ${label}\n`);
    };
}
