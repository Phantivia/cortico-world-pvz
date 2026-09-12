/**
 * 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。
 *
 * 配置段类型一并导出,给 bot 侧在 `declares` 覆盖里写 `worlds.pvz` 的字面量时用。
 */

import { PVZ } from './definition.ts';

export default PVZ;

export { PVZ };
export { PVZ_DEFAULTS, PVZ_CONFIG_GROUP, normalizePvzExecutablePath } from './config.ts';
export type { PvzConfigSection } from './config.ts';
