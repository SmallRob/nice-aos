// 客户端脚本按 Tab 拼接。片段顺序即浏览器里的定义顺序，init 必须留在最后。
import { PREAMBLE } from './viewerClient/preamble.js';
import { OVERVIEW } from './viewerClient/overview.js';
import { ONTOLOGY } from './viewerClient/ontology.js';
import { BLUEPRINT } from './viewerClient/blueprint.js';
import { DATA } from './viewerClient/data.js';
import { FLOW } from './viewerClient/flow.js';
import { ROUTE_MAP } from './viewerClient/routeMap.js';
import { PROP_FLOW } from './viewerClient/propFlow.js';
import { SCRIPTS_TAB } from './viewerClient/scriptsTab.js';
import { ENTITIES } from './viewerClient/entities.js';
import { STATS } from './viewerClient/stats.js';
import { CODE_GRAPH } from './viewerClient/codeGraph.js';
import { INIT } from './viewerClient/init.js';

export const CLIENT_BASE = [
  PREAMBLE,
  OVERVIEW,
  ONTOLOGY,
  BLUEPRINT,
  DATA,
  FLOW,
  ROUTE_MAP,
  PROP_FLOW,
  SCRIPTS_TAB,
  ENTITIES,
  STATS,
  CODE_GRAPH,
  INIT,
].join('');
