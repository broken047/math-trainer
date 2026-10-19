// Проверка генератора примеров из index.html.
// Запуск: node tests/generator.test.js
// Скрипт страницы выполняется в песочнице без браузера, примеры пересчитываются
// независимым вычислителем в точных дробях по правилам порядка действий.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const page = { window: {}, document: {}, localStorage: {}, console, Math, Date };
vm.createContext(page);
vm.runInContext(script + '\nthis.generateExample = generateExample; this.maxActionsFor = maxActionsFor;', page);

const SIGN = { '+': '+', '-': '−', '*': '×', '/': '÷' };

// ---- Свои дроби, независимо от кода страницы ----
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
const R = (n, d = 1) => { if (d < 0) { n = -n; d = -d; } const g = gcd(n, d) || 1; return { n: n / g + 0, d: d / g }; };
const OPS = {
    '+': (a, b) => R(a.n * b.d + b.n * a.d, a.d * b.d),
    '−': (a, b) => R(a.n * b.d - b.n * a.d, a.d * b.d),
    '×': (a, b) => R(a.n * b.n, a.d * b.d),
    '÷': (a, b) => R(a.n * b.d, a.d * b.n)
};
const cmp = (a, b) => a.n * b.d - b.n * a.d;
const places = a => { let d = a.d, t = 0, f = 0; while (d % 2 === 0) { d /= 2; t++; } while (d % 5 === 0) { d /= 5; f++; } return d === 1 ? Math.max(t, f) : Infinity; };

// Числа в текстовой записи: «12 345», «3,75», «3/4», «2 3/4» (между целой частью и дробью — U+2009)
const NUMBER = /(\d+(?: \d{3})*)(?:,(\d+))?(?: (\d+)\/(\d+))?(?:\/(\d+))?/y;

function evaluate(text) {
    const s = text.replace(/ /g, ' ');
    const values = [], ops = [], steps = [], numbers = [];
    const PRIORITY = { '+': 1, '−': 1, '×': 2, '÷': 2 };
    const apply = () => {
        const op = ops.pop(), b = values.pop(), a = values.pop();
        const result = OPS[op](a, b);
        steps.push({ a, op, b, result });
        values.push(result);
    };
    const readNumber = i => {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(s);
        if (!m) throw new Error('не разобрать число в «' + s + '» с позиции ' + i);
        const digits = m[1].replace(/ /g, '');
        const whole = Number(digits);
        let value, kind;
        if (m[5]) { value = R(whole, Number(m[5])); kind = { frac: [whole, Number(m[5])] }; }
        else if (m[3]) { value = R(whole * Number(m[4]) + Number(m[3]), Number(m[4])); kind = { frac: [Number(m[3]), Number(m[4])] }; }
        else if (m[2]) { value = R(Number(digits + m[2]), Math.pow(10, m[2].length)); kind = { dec: m[2] }; }
        else { value = R(whole); kind = {}; }
        numbers.push({ raw: m[0], value, ...kind });
        return { value, end: NUMBER.lastIndex };
    };
    let expectOperand = true;
    for (let i = 0; i < s.length;) {
        const c = s[i];
        if (c === ' ') { i++; continue; }
        if (/\d/.test(c)) { const r = readNumber(i); values.push(r.value); i = r.end; expectOperand = false; continue; }
        if (c === '−' && expectOperand) {
            const r = readNumber(i + 1); values.push(R(-r.value.n, r.value.d)); i = r.end; expectOperand = false; continue;
        }
        if (c === '(') { ops.push(c); expectOperand = true; }
        else if (c === ')') { while (ops[ops.length - 1] !== '(') apply(); ops.pop(); expectOperand = false; }
        else {
            while (ops.length && ops[ops.length - 1] !== '(' && PRIORITY[ops[ops.length - 1]] >= PRIORITY[c]) apply();
            ops.push(c); expectOperand = true;
        }
        i++;
    }
    while (ops.length) apply();
    return { answer: values[0], steps, numbers };
}

const carryAt = (a, b) => { for (; a || b; a = Math.floor(a / 10), b = Math.floor(b / 10)) if (a % 10 + b % 10 >= 10) return true; return false; };
const borrowAt = (a, b) => { for (; b; a = Math.floor(a / 10), b = Math.floor(b / 10)) if (a % 10 < b % 10) return true; return false; };

const opSets = [];
for (let mask = 1; mask < 16; mask++) opSets.push(['+', '-', '*', '/'].filter((_, i) => mask & (1 << i)));

let total = 0, failures = 0;
const impossible = [];
const stats = { divisionNoParens: 0, divisionAfterParens: 0, negativeAnswers: 0, small: { operands: 0, ones: 0 },
                fracAnswers: 0, decAnswers: 0, mixedKinds: 0, table: { facts: 0, edges: 0, distinct: new Set() } };
const fail = msg => { if (failures++ < 25) console.log('ОШИБКА', msg); };

const NO_FRACTIONS = { fractions: false, decimals: false };
const FRACTION_MODES = [
    { mode: 'дроби, одинаковые знаменатели', fractions: true, sameDenominators: true, decimals: false },
    { mode: 'дроби, разные знаменатели', fractions: true, sameDenominators: false, decimals: false },
    { mode: 'десятичные, 1 знак', fractions: false, decimals: true, decimalPlaces: 1 },
    { mode: 'десятичные, до 3 знаков', fractions: false, decimals: true, decimalPlaces: 3 },
    { mode: 'дроби и десятичные', fractions: true, sameDenominators: false, decimals: true, decimalPlaces: 2 }
];

function check(settings, perSetting) {
    const { ops, actions, range, negatives, complexity } = settings;
    const fractional = settings.fractions || settings.decimals;
    const name = `${ops.map(o => SIGN[o]).join('')} ${settings.table ? 'таблица умножения' : 'до ' + range}${negatives ? ' с отрицательными' : ''} ${settings.mode || complexity} x${actions}`;
    for (let n = 0; n < perSetting; n++) {
        const ex = page.generateExample(settings);
        if (!ex) { impossible.push(name); return; }
        total++;
        const label = `[${name}] ${ex.text} = ${ex.answer.n}/${ex.answer.d}`;
        let parsed;
        try { parsed = evaluate(ex.text); } catch (e) { fail(e.message + ': ' + label); continue; }
        const { answer, steps, numbers } = parsed;

        if (cmp(answer, ex.answer) !== 0) fail(`ответ не совпадает с порядком действий (${answer.n}/${answer.d}): ${label}`);
        if (steps.length !== actions) fail(`действий ${steps.length} вместо ${actions}: ${label}`);
        for (const s of steps) {
            if (!ops.some(o => SIGN[o] === s.op)) fail(`невыбранная операция ${s.op}: ${label}`);
            if (cmp(s.result, R(range)) > 0 || cmp(s.result, R(-range)) < 0 || (!negatives && s.result.n < 0))
                fail(`промежуточный результат ${s.result.n}/${s.result.d} вне предела: ${label}`);
            if (!fractional) {
                if (s.result.d !== 1) fail(`деление с остатком: ${label}`);
                if (s.op === '÷' && !settings.table && (Math.abs(s.b.n) < 2 || Math.abs(s.result.n) < 2)) fail(`вырожденное деление: ${label}`);
            }
            if (settings.table && !fractional) {
                // Только таблица: оба множителя, делитель и частное — от 1 до 10
                const inTable = v => v.d === 1 && Math.abs(v.n) >= 1 && Math.abs(v.n) <= 10;
                if (s.op === '×' && !(inTable(s.a) && inTable(s.b))) fail(`не из таблицы умножения ${s.a.n} × ${s.b.n}: ${label}`);
                if (s.op === '÷' && !(inTable(s.b) && inTable(s.result))) fail(`не из таблицы деления ${s.a.n} ÷ ${s.b.n}: ${label}`);
                if (s.op === '×' || s.op === '÷') {
                    stats.table.facts++;
                    const edge = v => Math.abs(v.n) === 1 || Math.abs(v.n) === 10;
                    const factors = s.op === '×' ? [s.a, s.b] : [s.b, s.result];
                    if (factors.some(edge)) stats.table.edges++;
                    stats.table.distinct.add(s.op + Math.abs(s.a.n) + ',' + Math.abs(s.b.n));
                }
            } else if ((s.op === '×' || s.op === '÷') && Math.abs(s.b.n) === s.b.d) fail(`умножение или деление на 1: ${label}`);
            if (!fractional && range > 10 && complexity !== 'all' && !negatives && (s.op === '+' || s.op === '−')) {
                const transition = s.op === '+' ? carryAt(s.a.n, s.b.n) : borrowAt(s.a.n, s.b.n);
                if (transition !== (complexity === 'carry')) fail(`тип вычислений ${s.a.n} ${s.op} ${s.b.n}: ${label}`);
            }
        }

        const fracs = numbers.filter(x => x.frac), decs = numbers.filter(x => x.dec);
        for (const x of numbers) {
            if (cmp(x.value, R(range)) > 0) fail(`число ${x.raw} больше предела: ${label}`);
            const digits = x.raw.split(/[, /]/)[0];
            const plain = digits.replace(/ /g, '');
            const expected = Number(plain) >= 10000 ? plain.replace(/\B(?=(\d{3})+$)/g, ' ') : plain;
            if (digits !== expected) fail(`разряды разделены неверно «${digits}»: ${label}`);
        }
        if (!negatives && ex.text.includes('(−')) fail(`отрицательное число без настройки: ${label}`);
        if (!settings.fractions && fracs.length) fail(`обыкновенная дробь без настройки: ${label}`);
        if (!settings.decimals && decs.length) fail(`десятичная дробь без настройки: ${label}`);
        if (fractional && !fracs.length && !decs.length) fail(`в примере нет дробей: ${label}`);
        for (const f of fracs) {
            const [num, den] = f.frac;
            if (num < 1 || num >= den || den > 10) fail(`дробь ${num}/${den} не правильная или знаменатель больше 10: ${label}`);
        }
        if (settings.fractions && settings.sameDenominators && new Set(fracs.map(f => f.frac[1])).size > 1)
            fail(`разные знаменатели в режиме одинаковых: ${label}`);
        if (settings.fractions && !settings.sameDenominators && fracs.some(f => gcd(f.frac[0], f.frac[1]) > 1))
            fail(`сократимая дробь в режиме разных знаменателей: ${label}`);
        for (const d of decs) {
            if (d.dec.length > settings.decimalPlaces) fail(`больше ${settings.decimalPlaces} знаков после запятой: ${label}`);
            if (d.dec.endsWith('0')) fail(`лишний ноль в конце десятичной дроби: ${label}`);
        }
        const expectedKind = fracs.length ? 'frac' : decs.length ? 'dec' : 'int';
        if (ex.answerKind !== expectedKind) fail(`ответ вводится как ${ex.answerKind}, а нужно ${expectedKind}: ${label}`);
        if (expectedKind === 'dec') {
            for (const s of steps) if (places(s.result) > settings.decimalPlaces) fail(`результат с лишними знаками после запятой: ${label}`);
        }
        if (expectedKind === 'frac' && ex.answer.d > 100) fail(`знаменатель ответа ${ex.answer.d}: ${label}`);

        if (/[+−] \d+ ÷/.test(ex.text)) stats.divisionNoParens++;
        if (/\) ÷/.test(ex.text)) stats.divisionAfterParens++;
        if (ex.answer.n < 0) stats.negativeAnswers++;
        if (ex.answerKind === 'frac') stats.fracAnswers++;
        if (ex.answerKind === 'dec') stats.decAnswers++;
        if (fracs.length && decs.length) stats.mixedKinds++;
        if (!fractional && range <= 20) for (const s of steps) if (s.op === '+' || s.op === '−') {
            stats.small.operands++;
            if (Math.abs(s.b.n) === 1 && s.b.d === 1) stats.small.ones++;
        }
    }
}

// Целые числа: все сочетания настроек
for (const ops of opSets)
for (const range of [10, 20, 100, 1000, 10000, 100000, 9999999])
for (const negatives of [false, true])
for (const complexity of negatives ? ['all'] : ['all', 'no-carry', 'carry'])
for (const actions of [1, 2, 3, 5, 10]) {
    if (actions > page.maxActionsFor(range)) continue;   // больше действий интерфейс не даст выбрать
    check({ ops, actions, range, negatives, complexity, ...NO_FRACTIONS }, 100);
}

// Таблица умножения: предел 100, умножение и деление только табличные
for (const ops of opSets)
for (const negatives of [false, true])
for (const complexity of negatives ? ['all'] : ['all', 'no-carry', 'carry'])
for (const actions of [1, 2, 3, 5, 10]) {
    check({ ops, actions, range: 100, table: true, negatives, complexity, ...NO_FRACTIONS }, 100);
}

// Дроби: тип вычислений для них не действует
for (const ops of opSets)
for (const range of [10, 20, 100, 1000])
for (const negatives of [false, true])
for (const mode of FRACTION_MODES)
for (const actions of [1, 2, 3, 5]) {
    check({ ops, actions, range, negatives, complexity: 'all', ...mode }, 30);
}

console.log(`Проверено примеров: ${total}, ошибок: ${failures}`);
console.log(`Деление без скобок («a + b ÷ c»): ${stats.divisionNoParens}, деление скобок («(a + b) ÷ c»): ${stats.divisionAfterParens}`);
console.log(`Отрицательных ответов: ${stats.negativeAnswers}`);
console.log(`Ответов обыкновенной дробью: ${stats.fracAnswers}, десятичной: ${stats.decAnswers}, примеров с обоими видами дробей: ${stats.mixedKinds}`);
console.log(`Доля «± 1» среди слагаемых при пределе 10 и 20: ${(100 * stats.small.ones / stats.small.operands).toFixed(1)}%`);
console.log(`Таблица умножения: действий × и ÷ ${stats.table.facts}, с 1 или 10 — ${(100 * stats.table.edges / stats.table.facts).toFixed(1)}%, разных пар чисел ${stats.table.distinct.size}`);
if (impossible.length) console.log(`Невозможные сочетания настроек (${impossible.length}):\n  ` + impossible.join('\n  '));

const show = (settings, count = 4) => Array.from({ length: count }, () => {
    const ex = page.generateExample(Object.assign({ negatives: false, complexity: 'all', fractions: false, decimals: false }, settings));
    if (!ex) return '—';
    const a = ex.answer, answer = a.d === 1 ? a.n : `${a.n}/${a.d}`;
    return `${ex.text.replace(/[   ]/g, ' ')} = ${answer}`;
}).join('  |  ');
console.log('\nПримеры:');
console.log('+−×÷ до 100, 2 действия:     ', show({ ops: ['+', '-', '*', '/'], actions: 2, range: 100 }));
console.log('× таблица, 1 действие:        ', show({ ops: ['*'], actions: 1, range: 100, table: true }, 8));
console.log('×÷ таблица, 1 действие:       ', show({ ops: ['*', '/'], actions: 1, range: 100, table: true }, 8));
console.log('+−×÷ таблица, 3 действия:     ', show({ ops: ['+', '-', '*', '/'], actions: 3, range: 100, table: true }, 4));
console.log('+− до 20, 9 действий:         ', show({ ops: ['+', '-'], actions: 9, range: 20 }, 2));
console.log('+−×÷ до 9 999 999, 2 действия:', show({ ops: ['+', '-', '*', '/'], actions: 2, range: 9999999 }, 2));
console.log('+− дроби, одинаковые знам.:   ', show({ ops: ['+', '-'], actions: 2, range: 10, fractions: true, sameDenominators: true }));
console.log('+−×÷ дроби, разные знам.:     ', show({ ops: ['+', '-', '*', '/'], actions: 2, range: 10, fractions: true, sameDenominators: false }));
console.log('+−×÷ десятичные, до 2 знаков: ', show({ ops: ['+', '-', '*', '/'], actions: 2, range: 100, decimals: true, decimalPlaces: 2 }));
console.log('+− дроби и десятичные:        ', show({ ops: ['+', '-'], actions: 2, range: 10, fractions: true, sameDenominators: false, decimals: true, decimalPlaces: 2 }));

process.exit(failures ? 1 : 0);
