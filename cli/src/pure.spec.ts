import {
  parseTtlToSeconds,
  parseTags,
  humanSize,
  humanAge,
  humanExpires,
  parseArgs,
  pick,
} from './cli';

describe('纯函数', () => {
  afterEach(() => jest.restoreAllMocks());

  // ---------- parseTtlToSeconds ----------

  describe('parseTtlToSeconds', () => {
    it('各时间单位换算正确', () => {
      expect(parseTtlToSeconds('30s')).toBe(30);
      expect(parseTtlToSeconds('5m')).toBe(300);
      expect(parseTtlToSeconds('2h')).toBe(7200);
      expect(parseTtlToSeconds('7d')).toBe(604800);
      expect(parseTtlToSeconds('1w')).toBe(604800);
      expect(parseTtlToSeconds('90ms')).toBe(0); // 0.09s 向下取整
      expect(parseTtlToSeconds('1500ms')).toBe(1);
      expect(parseTtlToSeconds('1.5m')).toBe(90);
    });

    it('纯数字视为秒', () => {
      expect(parseTtlToSeconds('3600')).toBe(3600);
    });

    it('容忍首尾空格', () => {
      expect(parseTtlToSeconds('  30s  ')).toBe(30);
    });

    it('非法 / 空值返回 undefined', () => {
      expect(parseTtlToSeconds('')).toBeUndefined();
      expect(parseTtlToSeconds(undefined)).toBeUndefined();
      expect(parseTtlToSeconds('abc')).toBeUndefined();
      expect(parseTtlToSeconds('-5s')).toBeUndefined(); // 不匹配负数
    });
  });

  // ---------- parseTags ----------

  describe('parseTags', () => {
    it('逗号分隔 + 去空白 + 过滤空', () => {
      expect(parseTags('a,b')).toEqual(['a', 'b']);
      expect(parseTags(' a , b ')).toEqual(['a', 'b']);
      expect(parseTags('a,,b')).toEqual(['a', 'b']);
      expect(parseTags('a')).toEqual(['a']);
    });

    it('空值返回 undefined', () => {
      expect(parseTags(undefined)).toBeUndefined();
      expect(parseTags('')).toBeUndefined();
    });
  });

  // ---------- humanSize ----------

  describe('humanSize', () => {
    it('字节/K/M 分界', () => {
      expect(humanSize(0)).toBe('0B');
      expect(humanSize(500)).toBe('500B');
      expect(humanSize(1023)).toBe('1023B');
      expect(humanSize(1024)).toBe('1.0K');
      expect(humanSize(1536)).toBe('1.5K');
      expect(humanSize(1048576)).toBe('1.0M');
      expect(humanSize(1572864)).toBe('1.5M');
    });
  });

  // ---------- humanAge / humanExpires ----------

  describe('humanAge', () => {
    it('把时间戳差格式化为 s/m/h/d', () => {
      const base = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(base);
      expect(humanAge(base)).toBe('0s');
      expect(humanAge(base - 30_000)).toBe('30s');
      expect(humanAge(base - 120_000)).toBe('2m');
      expect(humanAge(base - 7_200_000)).toBe('2h');
      expect(humanAge(base - 172_800_000)).toBe('2d');
    });
  });

  describe('humanExpires', () => {
    it('null/undefined → 空串', () => {
      expect(humanExpires(null)).toBe('');
      expect(humanExpires(undefined)).toBe('');
    });

    it('过去 → expired', () => {
      const base = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(base);
      expect(humanExpires(base - 1000)).toBe('expired');
    });

    it('未来 → 剩余时长', () => {
      const base = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(base);
      expect(humanExpires(base + 30_000)).toBe('30s');
      expect(humanExpires(base + 7_200_000)).toBe('2h');
      expect(humanExpires(base + 172_800_000)).toBe('2d');
    });
  });

  // ---------- parseArgs ----------

  describe('parseArgs', () => {
    const V = ['-m', '--message', '--tags', '--ttl'];

    it('短/长 值选项', () => {
      const r = parseArgs(['-m', 'hi', '--tags', 'a,b'], V);
      expect(r.opts['-m']).toBe('hi');
      expect(r.opts['--tags']).toBe('a,b');
      expect(r.positional).toEqual([]);
    });

    it('--opt=value 形式', () => {
      const r = parseArgs(['--kind=file'], V);
      expect(r.opts['--kind']).toBe('file');
    });

    it('未知 --flag 进 flags', () => {
      const r = parseArgs(['--verbose'], V);
      expect(r.flags.has('--verbose')).toBe(true);
      expect(r.opts).toEqual({});
    });

    it('位置参数收集', () => {
      const r = parseArgs(['push', 'file.txt'], V);
      expect(r.positional).toEqual(['push', 'file.txt']);
    });

    it('stdin 占位 "-" 作为 -m 值', () => {
      const r = parseArgs(['-m', '-'], V);
      expect(r.opts['-m']).toBe('-');
    });
  });

  // ---------- pick ----------

  describe('pick', () => {
    it('返回首个存在的键值', () => {
      expect(pick({ a: '1', b: '2' }, ['x', 'a', 'b'])).toBe('1');
      expect(pick({ b: '2' }, ['a', 'b'])).toBe('2');
    });

    it('都不存在返回 undefined', () => {
      expect(pick({ a: '1' }, ['x', 'y'])).toBeUndefined();
    });
  });
});
