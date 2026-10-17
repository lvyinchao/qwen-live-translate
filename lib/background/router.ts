import { AppError } from '../errors';
import type { BackgroundMessage, BackgroundResponse, BackgroundType } from '../messages';
import type { BackgroundContext } from './context';

export interface RouteContext<K extends BackgroundType> {
  ctx: BackgroundContext;
  message: BackgroundMessage<K>;
  sender: chrome.runtime.MessageSender;
}
export interface Route<K extends BackgroundType> {
  /** Extension pages only. A string is the rejection shown to other senders; a
   * `{ fallback }` quietly answers them instead. Omit for routes that validate
   * their own sender (content scripts, page bridges). */
  privileged?: string | { fallback: BackgroundResponse<K> };
  handle(route: RouteContext<K>): Promise<BackgroundResponse<K>> | BackgroundResponse<K>;
}
export type Routes = { [K in BackgroundType]: Route<K> };
export type RouteGroup<K extends BackgroundType> = { [T in K]: Route<T> };

export async function dispatch(
  routes: Routes,
  ctx: BackgroundContext,
  message: BackgroundMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  if (!Object.hasOwn(routes, message.type)) return undefined;
  const route = routes[message.type] as Route<BackgroundType>;
  if (route.privileged !== undefined && !ctx.trusted(sender)) {
    if (typeof route.privileged === 'string') throw new AppError('forbidden', route.privileged);
    return route.privileged.fallback;
  }
  return route.handle({ ctx, message, sender });
}
