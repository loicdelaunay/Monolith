import { HarnessError } from '@monolith/contracts';
import { assertPublicUrl, PrivateAddressError } from '../net/guard.ts';
import type { ToolContext } from './types.ts';

/**
 * Adresse demandée par le modèle : publique, ou locale / privée (localhost, 127.0.0.1, réseau local)
 * avec l'accord de l'utilisateur. L'accord passe par la politique d'autorisation (règle permanente
 * possible par hôte et port : `local-network:127.0.0.1:5173`) ; un refus ne transmet aucune requête.
 */
export async function allowedUrl(raw: string, ctx: ToolContext): Promise<URL> {
  try {
    return await assertPublicUrl(raw);
  } catch (error) {
    if (!(error instanceof PrivateAddressError)) throw error;
    const where = error.url.host;
    const ok = await ctx.authorize(['local-network', `local-network:${where}`], `Adresse locale · ${error.url.origin}`, `Accès à une adresse de ce poste ou du réseau local (${error.host})`);
    if (!ok) throw new HarnessError('permission_denied', `Accès à l’adresse locale ${where} refusé par l’utilisateur.`);
    return error.url;
  }
}
