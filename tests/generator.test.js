// Проверка генератора примеров из index.html.
// Запуск: node tests/generator.test.js
// Скрипт страницы выполняется в песочнице без браузера, примеры пересчитываются
// независимым вычислителем по правилам порядка действий.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const page = { window: {}, document: {}, localStorage: {}, console, Math };
vm.createContext(page);
vm.runInContext(script + '\nthis.generateExample = generateExample; this.maxActionsFor = maxActionsFor;', page);

const PER_SETTING = 100;
const SIGN = { '+': '+', '-': '−', '*': '×', '/': '÷' };

// Разбор и вычисление примера: возвращает ответ и все выполненные действия
function evaluate(text) {
    const tokens = text.replace(/ /g, '').replace(/ /g, ' ').match(/\d+|[()+−×÷]/g);
    const values = [], ops = [], steps = [];
    const PRIORITY = { '+': 1, '−': 1, '×': 2, '÷': 2 };
    const apply = () => {
        const op = ops.pop(), b = values.pop(), a = values.pop();
        const result = op === '+' ? a + b : op === '−' ? a - b : op === '×' ? a * b : a / b;
        steps.push({ a, op, b, result });
        values.push(result);
    };
    let expectOperand = true;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (/\d/.test(t)) { values.push(Number(t)); expectOperand = false; }
        else if (t === '−' && expectOperand) { values.push(-Number(tokens[++i])); expectOperand = false; }
        else if (t === '(') { ops.push(t); expectOperand = true; }
        else if (t === ')') { while (ops[ops.length - 1] !== '(') apply(); ops.pop(); expectOperand = false; }
        else {
            while (ops.length && ops[ops.length - 1] !== '(' && PRIORITY[ops[ops.length - 1]] >= PRIORITY[t]) apply();
            ops.push(t); expectOperand = true;
        }
    }
    while (ops.length) apply();
    return { answer: values[0], steps };
}

const carryAt = (a, b) => { for (; a || b; a = Math.floor(a / 10), b = Math.floor(b / 10)) if (a % 10 + b % 10 >= 10) return true; return false; };
const borrowAt = (a, b) => { for (; b; a = Math.floor(a / 10), b = Math.floor(b / 10)) if (a % 10 < b % 10) return true; return false; };

const opSets = [];
for (let mask = 1; mask < 16; mask++) opSets.push(['+', '-', '*', '/'].filter((_, i) => mask & (1 << i)));

let total = 0, failures = 0;
const impossible = [];
const stats = { divisionNoParens: 0, divisionAfterParens: 0, negativeAnswers: 0, small: { operands: 0, ones: 0 } };
const fail = msg => { if (failures++ < 20) console.log('ОШИБКА', msg); };

for (const ops of opSets)
for (const range of [10, 20, 100, 1000, 10000, 100000, 9999999])
for (const negatives of [false, true])
for (const complexity of negatives ? ['all'] : ['all', 'no-carry', 'carry'])
for (const actions of [1, 2, 3, 5, 10]) {
    if (actions > page.maxActionsFor(range)) continue;   // больше действий интерфейс не даст выбрать
    const settings = { ops, actions, range, negatives, complexity };
    const name = `${ops.map(o => SIGN[o]).join('')} до ${range}${negatives ? ' с отрицательными' : ''} ${complexity} x${actions}`;
    for (let n = 0; n < PER_SETTING; n++) {
        const ex = page.generateExample(settings);
        if (!ex) { impossible.push(name); break; }
        total++;
        const label = `[${name}] ${ex.text} = ${ex.answer}`;
        const { answer, steps } = evaluate(ex.text);

        if (answer !== ex.answer) fail(`ответ не совпадает с порядком действий (${answer}): ${label}`);
        if (steps.length !== actions) fail(`действий ${steps.length} вместо ${actions}: ${label}`);
        for (const s of steps) {
            if (!ops.some(o => SIGN[o] === s.op)) fail(`невыбранная операция ${s.op}: ${label}`);
            if (!Number.isInteger(s.result)) fail(`деление с остатком ${s.a} ÷ ${s.b}: ${label}`);
            if (Math.abs(s.result) > range || (!negatives && s.result < 0)) fail(`промежуточный результат ${s.result} вне предела: ${label}`);
            if (s.op === '÷' && (Math.abs(s.b) < 2 || Math.abs(s.result) < 2)) fail(`вырожденное деление: ${label}`);
            if (!negatives && range > 10 && complexity !== 'all' && (s.op === '+' || s.op === '−')) {
                const transition = s.op === '+' ? carryAt(s.a, s.b) : borrowAt(s.a, s.b);
                if (transition !== (complexity === 'carry')) fail(`тип вычислений ${s.a} ${s.op} ${s.b}: ${label}`);
            }
        }
        if (!negatives && ex.text.includes('(−')) fail(`отрицательное число без настройки: ${label}`);
        for (const group of ex.text.match(/\d+(?: \d{3})*/g)) {
            const digits = group.replace(/ /g, '');
            if (Number(digits) > range) fail(`число ${digits} больше предела: ${label}`);
            const expected = Number(digits) >= 10000 ? digits.replace(/\B(?=(\d{3})+$)/g, ' ') : digits;
            if (group !== expected) fail(`разряды разделены неверно «${group}»: ${label}`);
        }
        if (/[+−] \d+ ÷/.test(ex.text)) stats.divisionNoParens++;
        if (/\) ÷/.test(ex.text)) stats.divisionAfterParens++;
        if (ex.answer < 0) stats.negativeAnswers++;
        if (range <= 20) for (const s of steps) if (s.op === '+' || s.op === '−') {
            stats.small.operands++;
            if (Math.abs(s.b) === 1) stats.small.ones++;
        }
    }
}

console.log(`Проверено примеров: ${total}, ошибок: ${failures}`);
console.log(`Деление без скобок («a + b ÷ c»): ${stats.divisionNoParens}, деление скобок («(a + b) ÷ c»): ${stats.divisionAfterParens}`);
console.log(`Отрицательных ответов: ${stats.negativeAnswers}`);
console.log(`Доля «± 1» среди слагаемых при пределе 10 и 20: ${(100 * stats.small.ones / stats.small.operands).toFixed(1)}%`);
if (impossible.length) console.log(`Невозможные сочетания настроек (${impossible.length}):\n  ` + impossible.join('\n  '));

const show = (settings, count = 4) => Array.from({ length: count }, () => {
    const ex = page.generateExample(settings);
    return ex ? `${ex.text.replace(/ /g, ' ')} = ${ex.answer}` : '—';
}).join('  |  ');
console.log('\nПримеры:');
console.log('+−×÷ до 100, 2 действия:     ', show({ ops: ['+', '-', '*', '/'], actions: 2, range: 100, negatives: false, complexity: 'all' }));
console.log('+−×÷ до 100, 5 действий:     ', show({ ops: ['+', '-', '*', '/'], actions: 5, range: 100, negatives: false, complexity: 'all' }, 2));
console.log('+−×÷ до 1000, 10 действий:   ', show({ ops: ['+', '-', '*', '/'], actions: 10, range: 1000, negatives: false, complexity: 'all' }, 1));
console.log('+−×÷ до 9 999 999, 2 действия:', show({ ops: ['+', '-', '*', '/'], actions: 2, range: 9999999, negatives: false, complexity: 'all' }, 3));
console.log('+− до 20, 9 действий:         ', show({ ops: ['+', '-'], actions: 9, range: 20, negatives: false, complexity: 'all' }, 3));
console.log('+− до 10, 2 действия:         ', show({ ops: ['+', '-'], actions: 2, range: 10, negatives: false, complexity: 'all' }, 6));
console.log('+−×÷ до 20 с отрицательными: ', show({ ops: ['+', '-', '*', '/'], actions: 3, range: 20, negatives: true, complexity: 'all' }));

process.exit(failures ? 1 : 0);
