begin;

-- Store immutable evidence separately from driver files, which owners can overwrite.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-credentials', 'student-credentials', false, 1572864, array['image/jpeg']);

create table public.student_credential_requests (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  registered_name text not null,
  registered_number text not null,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  created_at timestamptz not null default now(),
  reading jsonb,
  analysis_status text not null default 'PROCESSING' check (analysis_status in ('PROCESSING','READ','UNAVAILABLE')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  reason text
);
create unique index student_credential_one_active on public.student_credential_requests(user_id)
  where status in ('PENDING','APPROVED');
alter table public.student_credential_requests enable row level security;
revoke all on public.student_credential_requests from public, anon, authenticated;
grant select on public.student_credential_requests to authenticated;
grant select, insert, update on public.student_credential_requests to service_role;
create policy credential_request_read on public.student_credential_requests for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy credential_evidence_read on storage.objects for select to authenticated
  using (bucket_id = 'student-credentials' and (public.is_admin() or (storage.foldername(name))[1] = auth.uid()::text));

create function public.review_student_credential(p_id uuid, p_approve boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.student_credential_requests;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Se requiere un administrador.' using errcode = '42501';
  end if;
  select * into strict r from public.student_credential_requests where id = p_id for update;
  if r.user_id = auth.uid() or r.status <> 'PENDING' then
    raise exception 'La solicitud no admite esta revisión.';
  end if;
  if p_approve is null or (not p_approve and length(trim(coalesce(p_reason,''))) not between 1 and 500) then
    raise exception 'Escribe un motivo de rechazo de hasta 500 caracteres.';
  end if;
  if p_approve then
    update public.profiles set student_verified = true, updated_at = now()
      where id = r.user_id and full_name = r.registered_name and student_number = r.registered_number;
    if not found then raise exception 'Los datos del perfil cambiaron. Solicita un nuevo envío.'; end if;
  end if;
  update public.student_credential_requests set
    status = case when p_approve then 'APPROVED' else 'REJECTED' end,
    reason = case when not p_approve then trim(p_reason) end,
    reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
end;
$$;
revoke all on function public.review_student_credential(uuid,boolean,text) from public, anon;
grant execute on function public.review_student_credential(uuid,boolean,text) to authenticated;
commit;
