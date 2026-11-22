// tiny-stack-vm: an exact interpreter for make.fun's tiny stack ISA, v1.
// Reads /input/<id>/program.bin + input.bin, writes the bytes the
// program produced to /output/<id>/stdout.bin and its exit code to
// /output/<id>/exit.txt. Node 22, standard library only; no clock, no
// randomness, no network, so two runs write byte-identical answers.
// Machine: 32-bit wrapping values, a 256-value data stack, a 64-deep
// call stack, 256 words of memory, 1,000,000 steps, 65,536 output
// bytes. A trap ends the program at once, keeps the output written
// before it, and its code is the exit code.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IN = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// [values popped, values pushed, immediate bytes] per opcode.
const SPEC = new Map([
  [0, [0, 0, 0]], [1, [0, 1, 1]], [2, [0, 1, 4]],
  [3, [1, 0, 0]], [4, [1, 2, 0]], [5, [2, 2, 0]],
  [6, [2, 3, 0]], [7, [3, 3, 0]],
  [16, [2, 1, 0]], [17, [2, 1, 0]], [18, [2, 1, 0]],
  [19, [2, 1, 0]], [20, [2, 1, 0]], [21, [2, 1, 0]],
  [22, [2, 1, 0]], [23, [1, 1, 0]], [24, [2, 1, 0]],
  [25, [2, 1, 0]], [26, [2, 1, 0]], [27, [1, 1, 0]],
  [28, [2, 1, 0]], [29, [2, 1, 0]], [30, [2, 1, 0]],
  [32, [2, 1, 0]], [33, [2, 1, 0]], [34, [2, 1, 0]],
  [48, [0, 0, 2]], [49, [1, 0, 2]], [50, [1, 0, 2]],
  [51, [0, 0, 2]], [52, [0, 0, 0]],
  [64, [1, 1, 0]], [65, [2, 0, 0]],
  [80, [1, 0, 0]], [81, [1, 0, 0]], [82, [0, 1, 0]],
  [83, [1, 0, 0]],
]);

// Runs one program on its input: the bytes it wrote and its exit code
// (0 on HALT, the low byte on EXIT, the trap code on a trap).
function run(p, input) {
  const n = p.length;
  const s = new Int32Array(256);
  const c = new Int32Array(64);
  const m = new Int32Array(256);
  const o = Buffer.alloc(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  const done = (e) => ({ out: o.subarray(0, ol), exit: e });
  for (;;) {
    if (steps === 1e6) return done(10); // step limit, checked first.
    if (pc < 0 || pc >= n) return done(9); // pc outside the program.
    const op = p[pc];
    const q = SPEC.get(op);
    if (!q) return done(5); // no opcode names this byte.
    const po = q[0], pu = q[1], im = q[2];
    if (pc + im >= n) return done(9); // immediate cut off by the end.
    steps++;
    const nx = pc + 1 + im;
    if (sp < po) return done(2); // stack underflow.
    if (sp - po + pu > 256) return done(3); // stack overflow.
    pc = nx;
    switch (op) {
      case 0: return done(0); // HALT.
      case 1: s[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended.
      case 2: // PUSH32, four bytes little-endian.
        s[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 3: sp--; break; // POP.
      case 4: s[sp] = s[sp - 1]; sp++; break; // DUP.
      case 5: { const t = s[sp - 1]; s[sp - 1] = s[sp - 2]; s[sp - 2] = t; break; } // SWAP.
      case 6: s[sp] = s[sp - 2]; sp++; break; // OVER.
      case 7: { const a = s[sp - 3]; s[sp - 3] = s[sp - 2]; s[sp - 2] = s[sp - 1]; s[sp - 1] = a; break; } // ROT: ( a b c -- b c a ).
      case 23: s[sp - 1] = -s[sp - 1] | 0; break; // NEG wraps: -(-2147483648) stays itself.
      case 27: s[sp - 1] = ~s[sp - 1]; break; // NOT.
      case 48: case 49: case 50: { // JMP, JZ, JNZ.
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 48) { const v = s[--sp]; take = op === 49 ? v === 0 : v !== 0; }
        if (take) pc = nx + rel; // pc is the next instruction plus the offset.
        break;
      }
      case 51: // CALL: push the return address, jump to the immediate.
        if (cp === 64) return done(7);
        c[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 52: // RET: an empty call stack traps.
        if (cp === 0) return done(8);
        pc = c[--cp];
        break;
      case 64: { // LOAD.
        const a = s[sp - 1];
        if (a < 0 || a >= 256) return done(6);
        s[sp - 1] = m[a];
        break;
      }
      case 65: { // STORE: ( v addr -- ), the address is on top.
        const a = s[sp - 1], v = s[sp - 2];
        if (a < 0 || a >= 256) return done(6);
        sp -= 2;
        m[a] = v;
        break;
      }
      case 80: { // PRINT: the value in decimal, no newline, no padding.
        const t = String(s[sp - 1]);
        if (ol + t.length > 65536) return done(11);
        sp--;
        ol += o.write(t, ol, "ascii");
        break;
      }
      case 81: // PUTC: one byte, the value's low 8 bits.
        if (ol + 1 > 65536) return done(11);
        o[ol++] = s[--sp] & 255;
        break;
      case 82: // IN: the next input byte, -1 once the input is used up.
        s[sp++] = ip < input.length ? input[ip++] : -1;
        break;
      case 83: return done(s[--sp] & 255); // EXIT: the low byte is the code.
      default: { // Two-operand arithmetic, logic, shift and compare ops.
        const b = s[sp - 1], a = s[sp - 2];
        let r;
        switch (op) {
          case 16: r = (a + b) | 0; break;
          case 17: r = (a - b) | 0; break;
          case 18: r = Math.imul(a, b); break; // low 32 bits, exact.
          case 19:
            if (b === 0) return done(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 20:
            if (b === 0) return done(4);
            r = b === -1 ? 0 : (a % b) | 0; // the remainder takes a's sign.
            break;
          case 21:
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 22:
            if (b === 0) return done(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 24: r = a & b; break;
          case 25: r = a | b; break;
          case 26: r = a ^ b; break;
          case 28: r = a << (b & 31); break; // only the low 5 bits count.
          case 29: r = a >> (b & 31); break; // arithmetic: the sign extends.
          case 30: r = (a >>> (b & 31)) | 0; break; // logical: zeros come in.
          case 32: r = a === b ? 1 : 0; break;
          case 33: r = a < b ? 1 : 0; break;
          case 34: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
          default: return done(5);
        }
        sp -= 2;
        s[sp++] = r;
        break;
      }
    }
  }
}

// Answers a whole set: every directory under /input is one instance,
// answered in its own directory under /output.
for (const id of readdirSync(IN).sort()) {
  const r = run(
    readFileSync(join(IN, id, "program.bin")),
    readFileSync(join(IN, id, "input.bin")),
  );
  const dir = join(OUT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout.bin"), r.out);
  writeFileSync(join(dir, "exit.txt"), String(r.exit));
}

