import { fetchLatestMessageTs, getConnectionState, type EvolutionDeps } from '../evolution/client.js';
import { isOwnDownNotice } from './down-notify.js';
import type { SystemProbe } from './down-notify-service.js';

/**
 * Sondas reais da vigia de sistema sobre a Evolution. Sem config aqui dentro — a
 * Evolution e a lista de pares entram por parâmetro —, para o teste de regressão
 * exercitar o MESMO caminho de produção com um `fetch` falso.
 *
 * O store é lido SEM os avisos do próprio vigia, no alvo e nos pares: o aviso vai
 * para o número vigiado e, contado como tráfego, fechava o episódio que ele mesmo
 * anunciava (ver `isOwnDownNotice`). Um caminho só para todos — par que um dia
 * receba aviso também não pode parecer "à frente" por causa dele.
 */
export function makeEvolutionProbe(evolution: EvolutionDeps, listPeerInstances: () => Promise<string[]>): SystemProbe {
  return {
    connectionState: (i: string) => getConnectionState(evolution, i),
    latestStoreTs: (i: string) => fetchLatestMessageTs(evolution, i, { skip: isOwnDownNotice }),
    listPeerInstances,
  };
}
