import { fetchLatestMessageTs, getConnectionState, type EvolutionDeps } from '../evolution/client.js';
import { isOwnDownNotice } from './down-notify.js';
import { isFromOwnCloudRecord } from './own-cloud.js';
import type { SystemProbe } from './down-notify-service.js';

/**
 * Sondas reais da vigia de sistema sobre a Evolution. Sem config aqui dentro — a
 * Evolution, a lista de pares e os telefones do nosso Cloud entram por parâmetro
 * —, para o teste de regressão exercitar o MESMO caminho de produção com um
 * `fetch` falso.
 *
 * O store é lido SEM o aviso do próprio vigia NEM o tráfego do nosso número
 * Cloud (aviso de queda, cópia, sonda), no alvo e nos pares: contado como
 * tráfego, esse tipo de mensagem "curava" o episódio que ele mesmo anunciava
 * (ver `isOwnDownNotice`) ou escondia uma sonda recém-mandada no topo do store.
 * Um caminho só para todos — par que um dia receba aviso/sonda também não pode
 * parecer "à frente" por causa dele.
 */
export function makeEvolutionProbe(
  evolution: EvolutionDeps,
  listPeerInstances: () => Promise<string[]>,
  ownPhones: string[],
): SystemProbe {
  const skip = (r: unknown) => isOwnDownNotice(r) || isFromOwnCloudRecord(r, ownPhones);
  return {
    connectionState: (i: string) => getConnectionState(evolution, i),
    latestStoreTs: (i: string) => fetchLatestMessageTs(evolution, i, { skip }),
    listPeerInstances,
  };
}
