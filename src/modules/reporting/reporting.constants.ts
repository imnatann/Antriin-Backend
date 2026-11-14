/**
 * Campus transaction monitoring page bounds. They match the other cursor pages
 * of the API (orders/wallet/reviews) so a client can reuse its pagination
 * helper, and they are shared by the service and its DTO so the two never
 * disagree about the accepted range.
 */
export const TRANSACTION_PAGE_LIMIT_DEFAULT = 25;
export const TRANSACTION_PAGE_LIMIT_MAX = 100;
