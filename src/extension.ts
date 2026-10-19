import * as vscode from 'vscode';

type Result = {
    status: 'done' | 'failed';
    at: number;
    early?: number;
};

const RESULT_LIFETIME = 60 * 60 * 1000;

let item: vscode.StatusBarItem;
let barItem: vscode.StatusBarItem;
let context: vscode.ExtensionContext;
let tick = 0;
let warnedDay = false;
let warnedHour = false;
let asking = false;

function parseDate(text: string): Date | undefined {
    const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/);
    if (!m) {
        return undefined;
    }
    const date = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59);
    return isNaN(date.getTime()) ? undefined : date;
}

function pad(n: number): string {
    return n.toString().padStart(2, '0');
}

function formatDuration(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor(totalSeconds / 3600) % 24;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const seconds = totalSeconds % 60;
    const daysText = days > 0 ? `${days} д ` : '';
    return `${daysText}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function getConfig() {
    return vscode.workspace.getConfiguration('deadlineCountdown');
}

function getName(): string {
    return getConfig().get<string>('name', 'Дедлайн');
}

function getDeadline(): Date | undefined {
    return parseDate(getConfig().get<string>('date', ''));
}

function getResult(): Result | undefined {
    return context.globalState.get<Result>('result');
}

function mix(a: number[], b: number[], t: number): number[] {
    return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

function barColor(part: number): string {
    const green = [76, 175, 80];
    const yellow = [255, 193, 7];
    const red = [244, 67, 54];
    const rgb = part < 0.5 ? mix(green, yellow, part * 2) : mix(yellow, red, (part - 0.5) * 2);
    return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
}

function updateBar(deadline: Date | undefined) {
    const start = context.globalState.get<number>('startTime');
    if (!deadline || !start || start >= deadline.getTime()) {
        barItem.hide();
        return;
    }
    const part = Math.min(1, Math.max(0, (Date.now() - start) / (deadline.getTime() - start)));
    const filled = Math.round(part * 10);
    barItem.text = '▰'.repeat(filled) + '▱'.repeat(10 - filled);
    barItem.color = barColor(part);
    barItem.tooltip = `Прошло ${Math.round(part * 100)}% времени`;
    barItem.show();
}

function showResult(result: Result, name: string) {
    if (result.status === 'done') {
        item.text = result.early && result.early >= 60
            ? `🏆 ${name}: сдано за ${formatDuration(result.early)} до дедлайна`
            : `🎉 ${name}: сдано!`;
    } else {
        item.text = `💀 ${name}: не успел`;
    }
    const left = Math.max(0, Math.ceil((result.at + RESULT_LIFETIME - Date.now()) / 60000));
    item.tooltip = `Надпись исчезнет через ${left} мин\nНажми, чтобы задать новый дедлайн`;
    item.show();
    updateBar(undefined);
}

function update() {
    tick++;
    const name = getName();
    const deadline = getDeadline();
    const result = getResult();

    if (result) {
        if (Date.now() - result.at >= RESULT_LIFETIME) {
            void resetAll();
            return;
        }
        showResult(result, name);
        return;
    }

    if (!deadline) {
        item.text = '⏰ Дедлайн не задан';
        item.tooltip = 'Нажми, чтобы задать дедлайн';
        item.show();
        updateBar(undefined);
        return;
    }

    const ms = deadline.getTime() - Date.now();

    if (ms <= 0) {
        item.text = `⌛ ${name}: время вышло`;
        item.tooltip = 'Нажми, чтобы ответить, успел ли ты';
        item.show();
        updateBar(undefined);
        void askResult();
        return;
    }

    const totalSeconds = Math.floor(ms / 1000);

    let mood: string;
    if (totalSeconds >= 3 * 86400) {
        mood = '😎';
    } else if (totalSeconds >= 86400) {
        mood = '🙂';
    } else if (totalSeconds >= 3600) {
        mood = '😰';
    } else {
        mood = tick % 2 === 0 ? '😱' : '🔥';
    }

    item.text = `${mood} ${name}: ${formatDuration(totalSeconds)}`;
    item.tooltip = `Дедлайн: ${deadline.toLocaleString('ru-RU')}\nНажми, чтобы открыть меню`;
    item.show();
    updateBar(deadline);

    if (totalSeconds < 86400 && !warnedDay) {
        warnedDay = true;
        vscode.window.showInformationMessage(`🙂 До «${name}» осталось меньше суток. Пора начинать!`);
    }
    if (totalSeconds < 3600 && !warnedHour) {
        warnedHour = true;
        vscode.window.showWarningMessage(`⏰ До «${name}» осталось меньше часа!`);
    }
}

function resetWarnings() {
    warnedDay = false;
    warnedHour = false;
}

async function resetAll() {
    await context.globalState.update('startTime', undefined);
    await context.globalState.update('result', undefined);
    await getConfig().update('date', undefined, vscode.ConfigurationTarget.Global);
    resetWarnings();
    update();
}

async function saveResult(result: Result) {
    await context.globalState.update('result', result);
    update();
}

async function offerNewDeadline(message: string) {
    const answer = await vscode.window.showInformationMessage(message, 'Задать новый дедлайн');
    if (answer) {
        await setDeadline();
    }
}

async function askResult() {
    if (asking || getResult() || !getDeadline()) {
        return;
    }
    asking = true;
    const name = getName();
    const answer = await vscode.window.showInformationMessage(
        `⏰ Время вышло! Ты успел сдать «${name}»?`,
        '✅ Успел',
        '❌ Не успел'
    );
    asking = false;

    if (answer === '✅ Успел') {
        await saveResult({ status: 'done', at: Date.now() });
        await offerNewDeadline('🎉 Красавчик! Можно отдыхать.');
    } else if (answer === '❌ Не успел') {
        await saveResult({ status: 'failed', at: Date.now() });
        await offerNewDeadline('💀 Бывает. Иди договаривайся с преподом.');
    }
}

async function markDone() {
    const deadline = getDeadline();
    if (!deadline || getResult()) {
        vscode.window.showInformationMessage('Сейчас нет активного дедлайна');
        return;
    }
    const early = Math.floor((deadline.getTime() - Date.now()) / 1000);
    if (early <= 0) {
        await askResult();
        return;
    }
    await saveResult({ status: 'done', at: Date.now(), early });
    await offerNewDeadline(`🏆 Сдано за ${formatDuration(early)} до дедлайна. Так держать!`);
}

async function setDeadline() {
    const config = getConfig();

    const name = await vscode.window.showInputBox({
        prompt: 'Как называется дедлайн?',
        value: config.get<string>('name', 'Дедлайн')
    });
    if (name === undefined) {
        return;
    }

    const dateText = await vscode.window.showInputBox({
        prompt: 'Когда дедлайн? Формат: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ',
        placeHolder: '2026-10-31 23:59',
        value: config.get<string>('date', ''),
        validateInput: text => parseDate(text) ? undefined : 'Неверный формат. Пример: 2026-10-31 23:59'
    });
    if (dateText === undefined) {
        return;
    }

    await context.globalState.update('startTime', Date.now());
    await context.globalState.update('result', undefined);
    await config.update('name', name || 'Дедлайн', vscode.ConfigurationTarget.Global);
    await config.update('date', dateText.trim(), vscode.ConfigurationTarget.Global);
    resetWarnings();
    update();
    vscode.window.showInformationMessage(`Дедлайн «${name || 'Дедлайн'}» сохранён`);
}

async function clearDeadline() {
    await resetAll();
    vscode.window.showInformationMessage('Дедлайн убран. Можно расслабиться 😌');
}

async function openMenu() {
    const deadline = getDeadline();
    const result = getResult();

    if (result || !deadline) {
        await setDeadline();
        return;
    }
    if (deadline.getTime() <= Date.now()) {
        await askResult();
        return;
    }

    const choice = await vscode.window.showQuickPick(
        ['✅ Я уже сделал', '✏️ Изменить дедлайн', '🗑️ Убрать дедлайн'],
        { placeHolder: getName() }
    );
    if (choice === '✅ Я уже сделал') {
        await markDone();
    } else if (choice === '✏️ Изменить дедлайн') {
        await setDeadline();
    } else if (choice === '🗑️ Убрать дедлайн') {
        await clearDeadline();
    }
}

export function activate(ctx: vscode.ExtensionContext) {
    context = ctx;
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.command = 'deadline-countdown.menu';
    barItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    barItem.command = 'deadline-countdown.menu';

    context.subscriptions.push(
        item,
        barItem,
        vscode.commands.registerCommand('deadline-countdown.menu', openMenu),
        vscode.commands.registerCommand('deadline-countdown.setDeadline', setDeadline),
        vscode.commands.registerCommand('deadline-countdown.clearDeadline', clearDeadline),
        vscode.commands.registerCommand('deadline-countdown.markDone', markDone),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('deadlineCountdown')) {
                resetWarnings();
                update();
            }
        })
    );

    const timer = setInterval(update, 1000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });

    update();
}

export function deactivate() {}