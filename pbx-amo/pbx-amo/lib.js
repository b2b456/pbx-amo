'use strict';
// Чистые функции без зависимостей — их можно проверить тестами локально.

const SOURCE = 'own_pbx';

// Приводит номер к виду 7XXXXXXXXXX (только цифры).
// 8707... -> 7707..., 707... -> 7707...
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d;
}

function unixTs(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

function callResultText(row) {
  if (row.answered_at) return 'Разговор состоялся';
  return row.direction === 'inbound' ? 'Пропущенный' : 'Не дозвонился';
}

// POST /api/v4/calls — для номера, который уже есть в amo
function buildCallBody(row) {
  const ts = unixTs(row.started_at);
  const body = {
    direction: row.direction,
    uniq: row.call_uid,
    duration: row.duration_sec || 0,
    source: SOURCE,
    phone: '+' + row.phone,
    call_result: callResultText(row),
    call_status: row.answered_at ? 4 : 6, // 4 — разговор состоялся, 6 — не дозвонился
    created_at: ts,
    updated_at: ts,
  };
  if (row.recording_url) body.link = row.recording_url;
  return [body];
}

// POST /api/v4/leads/unsorted/sip — для неизвестного номера (создаёт заявку в «Неразобранном»)
function buildUnsortedBody(row, pipelineId) {
  const ts = unixTs(row.started_at);
  const metadata = {
    is_call_event_needed: true,
    uniq: row.call_uid,
    duration: row.duration_sec || 0,
    service_code: SOURCE,
    phone: '+' + row.phone,
    called_at: ts,
    from: SOURCE,
  };
  if (row.recording_url) metadata.link = row.recording_url;

  const item = {
    request_id: row.call_uid,
    source_uid: SOURCE,
    source_name: 'Своя АТС',
    created_at: ts,
    metadata,
    _embedded: {
      leads: [{ name: 'Звонок +' + row.phone }],
      contacts: [
        {
          name: '+' + row.phone,
          custom_fields_values: [
            { field_code: 'PHONE', values: [{ value: '+' + row.phone, enum_code: 'WORK' }] },
          ],
        },
      ],
    },
  };
  if (pipelineId) item.pipeline_id = Number(pipelineId);
  return [item];
}

module.exports = { SOURCE, normalizePhone, buildCallBody, buildUnsortedBody };
