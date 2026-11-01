begin;

/* ------------------------------------------------------------------ */
/* 0002 — storage quotas sized for the free tiers                     */
/*                                                                    */
/* The original defaults (Free 2 GB, Premium 10 GB) assumed paid      */
/* object storage. This deployment stores files in Cloudflare R2,     */
/* which grants 10 GB in total on the free plan, so the quotas are    */
/* re-sized to fit:                                                   */
/*                                                                    */
/*   Free    200 MiB  (~50 accounts fill the free R2 tier)            */
/*   Premium   2 GiB  (~5 paying accounts fill it)                    */
/*                                                                    */
/* Both stay configurable: FREE_PLAN_STORAGE_BYTES /                 */
/* PREMIUM_PLAN_STORAGE_BYTES in the environment, and per plan from   */
/* the admin dashboard (Admin → Pricing → storage bytes).             */
/*                                                                    */
/* Only rows that still carry the old seeded defaults are rewritten,  */
/* so any price/quota an administrator already customised survives.   */
/* ------------------------------------------------------------------ */

alter table subscription_plans
  alter column storage_bytes set default 2147483648;

update subscription_plans
   set storage_bytes = 2147483648
 where storage_bytes = 10000000000;

update subscription_plans
   set description = replace(description, '10 GB cloud storage', '2 GB cloud storage')
 where description like '%10 GB cloud storage%';

update subscription_plans
   set features = replace(features::text, '10 GB cloud storage', '2 GB cloud storage')::jsonb
 where features::text like '%10 GB cloud storage%';

/* Default upload cap: 50 MiB instead of 100 MiB. Existing admin choices
   are preserved — only the untouched seeded value is rewritten. */
update settings
   set value = jsonb_set(value, '{maxUploadBytes}', '52428800'::jsonb)
 where key = 'storage'
   and value->>'maxUploadBytes' = '104857600';

commit;
