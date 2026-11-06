create table if not exists calls (
  id           bigserial primary key,
  call_uid     text unique not null,
  direction    text not null check (direction in ('inbound', 'outbound')),
  phone        text not null,
  operator     text,
  started_at   timestamptz not null default now(),
  answered_at  timestamptz,
  ended_at     timestamptz,
  duration_sec int not null default 0,
  status       text not null default 'ringing',   -- ringing | answered | missed
  amo_status   text not null default 'pending',   -- pending | sent | error
  amo_error    text,
  recording_url text
);

create index if not exists calls_phone_idx on calls (phone);
create index if not exists calls_started_idx on calls (started_at desc);
