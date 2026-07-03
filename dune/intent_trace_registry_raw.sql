-- IntentTraceRegistry raw-log fallback query for DuneSQL.
-- Replace `sepolia.logs` with the raw logs table for the chain where the registry is deployed,
-- and replace registry_address with INTENT_TRACE_REGISTRY_ADDRESS.
--
-- Dune also creates decoded event tables for registered ABIs, named like:
-- [projectname_blockchain].[contractName]_evt_[eventName]
-- This raw query is useful before decoded tables are available.

with
params as (
  select
    0xc5649f0e5f4861387430727a0e877f72ab2ba16c as registry_address
),
registry_logs as (
  select l.*
  from sepolia.logs l
  join params p on l.contract_address = p.registry_address
  where l.block_time >= now() - interval '7' day
    and l.topic0 in (
      0x489cf0040ef49ebacebafc422b48653e85f1f29af8878f9d74f55cdb0f8c7434, -- IntentRegistered
      0x7cf274648f2f75f2df86db7d28352b646fe6bc8b2e5684774da01abb7709914c, -- TraceStepRecorded
      0xaeed72a56245f88a1ad108d50e405c9b6fbe4e56c60134e7173ac9d37010da4b, -- ExternalTransactionRecorded
      0x90be6820f37f5c83a3c6ba658fa5d42ae66c1806be2aa033e60ef8c389f8bd73  -- IntentStatusUpdated
    )
),
intent_registered as (
  select
    block_time,
    block_number,
    tx_hash as registry_tx_hash,
    topic1 as intent_id,
    varbinary_substring(topic2, 13, 20) as user_address,
    topic3 as source_chain_key,
    varbinary_substring(data, 1, 32) as user_ref,
    varbinary_substring(data, 33, 32) as destination_chain_key,
    varbinary_substring(data, 65, 32) as protocol_key,
    varbinary_substring(data, 97, 32) as action_key,
    varbinary_substring(data, 129, 32) as asset_key,
    varbinary_to_uint256(varbinary_substring(data, 161, 32)) as amount_raw,
    varbinary_to_uint256(varbinary_substring(data, 193, 32)) as event_ts
  from registry_logs
  where topic0 = 0x489cf0040ef49ebacebafc422b48653e85f1f29af8878f9d74f55cdb0f8c7434
),
trace_steps as (
  select
    block_time,
    block_number,
    tx_hash as registry_tx_hash,
    topic1 as intent_id,
    topic2 as stage_key,
    topic3 as chain_key,
    varbinary_to_uint256(varbinary_substring(data, 1, 32)) as step_index,
    varbinary_substring(data, 33, 32) as tx_hash_ref,
    varbinary_substring(data, 77, 20) as target_contract,
    varbinary_substring(data, 97, 4) as function_selector,
    varbinary_substring(data, 129, 32) as protocol_key,
    varbinary_to_uint256(varbinary_substring(data, 161, 32)) as amount_raw,
    varbinary_to_uint256(varbinary_substring(data, 193, 32)) as event_ts
  from registry_logs
  where topic0 = 0x7cf274648f2f75f2df86db7d28352b646fe6bc8b2e5684774da01abb7709914c
),
external_refs as (
  select
    tx_hash as registry_tx_hash,
    topic1 as intent_id,
    varbinary_to_uint256(topic2) as step_index,
    topic3 as chain_key,
    varbinary_substring(data, 1, 32) as tx_hash_ref,
    from_utf8(varbinary_substring(
      data,
      97,
      cast(varbinary_to_uint256(varbinary_substring(data, 65, 32)) as integer)
    )) as external_tx_hash
  from registry_logs
  where topic0 = 0xaeed72a56245f88a1ad108d50e405c9b6fbe4e56c60134e7173ac9d37010da4b
),
status_updates as (
  select
    block_time,
    block_number,
    tx_hash as registry_tx_hash,
    topic1 as intent_id,
    varbinary_to_uint256(topic2) as status_code,
    varbinary_to_uint256(varbinary_substring(data, 1, 32)) as event_ts
  from registry_logs
  where topic0 = 0x90be6820f37f5c83a3c6ba658fa5d42ae66c1806be2aa033e60ef8c389f8bd73
)
select
  'intent_registered' as event_type,
  block_time,
  block_number,
  registry_tx_hash,
  intent_id,
  cast(null as uint256) as step_index,
  source_chain_key as chain_key,
  cast(null as varbinary) as stage_key,
  cast(null as varbinary) as tx_hash_ref,
  cast(null as varchar) as external_tx_hash,
  protocol_key,
  amount_raw,
  cast(amount_raw as double) / 1e6 as amount_usdc,
  cast(null as uint256) as status_code
from intent_registered

union all

select
  'trace_step' as event_type,
  s.block_time,
  s.block_number,
  s.registry_tx_hash,
  s.intent_id,
  s.step_index,
  s.chain_key,
  s.stage_key,
  s.tx_hash_ref,
  e.external_tx_hash,
  s.protocol_key,
  s.amount_raw,
  cast(s.amount_raw as double) / 1e6 as amount_usdc,
  cast(null as uint256) as status_code
from trace_steps s
left join external_refs e
  on s.intent_id = e.intent_id
 and s.step_index = e.step_index
 and s.chain_key = e.chain_key

union all

select
  'status_update' as event_type,
  block_time,
  block_number,
  registry_tx_hash,
  intent_id,
  cast(null as uint256) as step_index,
  cast(null as varbinary) as chain_key,
  cast(null as varbinary) as stage_key,
  cast(null as varbinary) as tx_hash_ref,
  cast(null as varchar) as external_tx_hash,
  cast(null as varbinary) as protocol_key,
  cast(null as uint256) as amount_raw,
  cast(null as double) as amount_usdc,
  status_code
from status_updates
order by block_time desc, registry_tx_hash desc, step_index nulls first;
