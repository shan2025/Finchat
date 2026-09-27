-- pg_cron jobs for the dream cycle and the nightly digest.
--
-- These replace two in-process setInterval timers in server.js that reset on
-- every deploy: the 24h digest last ran on 2026-08-17. Same shape as the
-- existing trigger_mission_tick / trigger_route_learning functions — pg_net
-- POSTs to the Render service with the shared secret from Vault.
--
-- Apply once against the Supabase database (idempotent: CREATE OR REPLACE, and
-- cron.schedule updates a job that already has the same name):
--   node scripts/pg_cron/apply.js scripts/pg_cron/dream_jobs.sql
--
-- Times are UTC. The digest runs a dream pass of its own first, so the dream
-- job skips the 00:00 slot rather than consolidating twice in a row.
--   dream   06:00, 12:00, 18:00 UTC
--   digest  00:00 UTC (05:30 IST, before the 08:00 IST morning briefing)

create or replace function public.trigger_cron_endpoint(p_path text)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'vault', 'net'
as $function$
declare
  v_base_url   text := 'https://finchat-sg.onrender.com';
  v_secret     text;
  v_request_id bigint;
begin
  if p_path not in ('/api/cron/dream', '/api/cron/digest') then
    raise exception 'trigger_cron_endpoint: % is not an allowed cron path', p_path;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'finchat_cron_secret';

  if v_secret is null then
    raise exception 'Vault secret "finchat_cron_secret" is missing; % would reject this call with 401.', p_path;
  end if;

  select net.http_post(
    url := v_base_url || p_path,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    -- Render's free tier cold-starts in ~50s; the endpoints answer 202 at once.
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$function$;

-- Only the cron owner may call it. Functions default to EXECUTE for PUBLIC,
-- which on Supabase exposes them through the REST API's /rpc endpoint.
revoke execute on function public.trigger_cron_endpoint(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.trigger_cron_endpoint(text) from anon, authenticated';
  end if;
end $$;

select cron.schedule('finchat-dream-cycle',  '0 6,12,18 * * *', $$ select public.trigger_cron_endpoint('/api/cron/dream'); $$);
select cron.schedule('finchat-dream-digest', '0 0 * * *',        $$ select public.trigger_cron_endpoint('/api/cron/digest'); $$);
