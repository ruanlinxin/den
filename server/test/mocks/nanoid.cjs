/**
 * nanoid CJS mock —— 仅用于 jest 单元测试。
 * nanoid v5 是纯 ESM,ts-jest 默认编译成 CJS 无法 require;
 * id 生成本身非测试重点,用单调递增计数器即可。
 * 仍保留 8 位长度约定,且 store 的「id 冲突重试」逻辑可用 forceCollideN 控制。
 */
let i = 0;
// 测试可注入:让前 N 次 nanoid 返回固定值以制造碰撞
let collideN = 0;
let collideVal = 'COLLIDE';

module.exports = {
  nanoid: (size = 8) => {
    if (collideN > 0) {
      collideN--;
      return collideVal;
    }
    i++;
    return ('id' + i).padEnd(size, '0').slice(0, size);
  },
  // 测试辅助 hook(非 nanoid 公共 API,仅供 mock 控制)
  __setCollide(n, val) {
    collideN = n;
    collideVal = val;
  },
};
