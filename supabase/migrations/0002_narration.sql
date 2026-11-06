-- Public bucket for the guided demo's voiced narration (mp3 per line, written by the server
-- with the service role key). Public read only: nothing here is private.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('narration', 'narration', true, 2097152, array['audio/mpeg'])
on conflict (id) do nothing;
