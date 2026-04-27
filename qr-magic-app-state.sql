-- Supabase SQL エディタで 1 回実行してください（無料枠で可）
-- 環境変数: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY（サーバー専用・GitHub に載せない）

create table if not exists public.qr_magic_app_state (
  id smallint primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.qr_magic_app_state enable row level security;

comment on table public.qr_magic_app_state is 'qr-magic Node サーバーの state.json 相当（service_role のみ利用想定）';
