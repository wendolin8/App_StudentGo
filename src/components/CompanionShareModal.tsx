import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { UserPlus, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { createCompanion, setCompanionshipPreference, type CompanionInput } from '@/lib/companions';
import { getCurrentPosition } from '@/lib/maps';

type Option = 'contacts' | 'person' | 'both' | 'none';
type ContactRow = { name: string; relationship: string; phone: string; whatsapp_consent_at: string | null };
type CreatedLink = { label: string; status: string; detail: string };

const OPTIONS: { value: Option; label: string }[] = [
  { value: 'contacts', label: 'Mis contactos de emergencia' },
  { value: 'person', label: 'Una persona que me espera' },
  { value: 'both', label: 'Ambos' },
  { value: 'none', label: 'Ahora no' },
];

export default function CompanionShareModal({ tripId, tripRequestId, userId, tripLabel, activeCount, onClose, onCreated }: { tripId: string; tripRequestId: string; userId: string; tripLabel: string; activeCount: number; onClose: () => void; onCreated: () => void }) {
  const [option, setOption] = useState<Option>('contacts');
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [form, setForm] = useState({ name: '', relationship: '', phone: '' });
  const [consent, setConsent] = useState(false);
  const [recipientConsent, setRecipientConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<CreatedLink[]>([]);

  useEffect(() => {
    let active = true;
    void supabase.from('emergency_contacts').select('name, relationship, phone, whatsapp_consent_at').eq('user_id', userId).order('created_at').then(({ data, error: loadError }) => {
      if (!active) return;
      setContacts(loadError ? [] : ((data ?? []) as ContactRow[]));
    });
    return () => { active = false; };
  }, [userId]);

  const wantsContacts = option === 'contacts' || option === 'both';
  const wantsPerson = option === 'person' || option === 'both';
  const slotsFree = 3 - activeCount;
  const targetCount = (wantsContacts ? (contacts?.length ?? 0) : 0) + (wantsPerson ? 1 : 0);

  async function saveNowNot() {
    setBusy(true);
    setError('');
    const preference = await setCompanionshipPreference(tripId, 'NOW_NOT', false);
    setBusy(false);
    if (!preference.ok) { setError(preference.message); return; }
    onCreated();
    onClose();
  }

  async function submit() {
    setError('');
    if (option === 'none') {
      await saveNowNot();
      return;
    }
    if (!consent) { setError('Debes autorizar compartir tu ubicación con estas personas.'); return; }
    if (wantsContacts && (contacts?.length !== 2 || contacts.some((contact) => !contact.whatsapp_consent_at))) { setError('Debes tener exactamente dos contactos con autorización vigente de WhatsApp. Revísalos en Perfil → Seguridad.'); return; }
    if (wantsPerson && (!form.name.trim() || !form.relationship.trim() || !/^\+[1-9][0-9]{9,14}$/.test(form.phone.replace(/[\s()-]/g, '')))) { setError('Completa nombre, relación y celular internacional con lada (por ejemplo +522221234567).'); return; }
    if (wantsPerson && !recipientConsent) { setError('Confirma que la persona que te espera autorizó recibir el enlace por WhatsApp.'); return; }
    if (wantsContacts && wantsPerson && contacts?.some((contact) => contact.phone.replace(/[\s()-]/g, '') === form.phone.replace(/[\s()-]/g, ''))) { setError('La persona que te espera ya aparece como contacto de emergencia. Evita duplicarla.'); return; }
    if (targetCount > slotsFree) { setError('Este viaje ya tiene el máximo de enlaces activos.'); return; }

    setBusy(true);
    let initialPosition;
    try {
      initialPosition = await getCurrentPosition();
    } catch (locationError) {
      setBusy(false);
      setError(locationError instanceof Error ? `${locationError.message} No se creó ningún enlace ni se solicitó WhatsApp.` : 'No pudimos obtener tu ubicación. No se creó ningún enlace ni se solicitó WhatsApp.');
      return;
    }
    const selection = option === 'contacts' ? 'EMERGENCY_CONTACTS' : option === 'person' ? 'WAITING_PERSON' : 'BOTH';
    const preference = await setCompanionshipPreference(tripId, selection, true);
    if (!preference.ok) { setBusy(false); setError(preference.message); return; }
    const inputs: { label: string; input: CompanionInput }[] = [];
    if (wantsContacts) contacts?.forEach((c) => inputs.push({ label: c.name, input: { name: c.name, relationship: c.relationship, phone: c.phone, source: 'EMERGENCY_CONTACT', locationConsent: consent, whatsappConsent: !!c.whatsapp_consent_at } }));
    if (wantsPerson) inputs.push({ label: form.name.trim(), input: { name: form.name.trim(), relationship: form.relationship.trim(), phone: form.phone.replace(/[\s()-]/g, ''), source: 'COMPANION', locationConsent: consent, whatsappConsent: recipientConsent } });

    const created: CreatedLink[] = [];
    for (const item of inputs) {
      const outcome = await createCompanion(tripRequestId, item.input);
      if (!outcome.ok) { created.push({ label: item.label, status: 'NO_CREADO', detail: outcome.message }); continue; }
      const { data: locationSaved, error: locationError } = await supabase.rpc('record_companion_location', {
        p_trip_request_id: tripRequestId,
        p_latitude: initialPosition.lat,
        p_longitude: initialPosition.lng,
      });
      if (locationError || locationSaved !== true) {
        created.push({ label: item.label, status: 'GPS_PENDIENTE', detail: 'El enlace se creó, pero no se solicitó WhatsApp porque no se pudo guardar la ubicación inicial.' });
        setError('No se pudo guardar la ubicación inicial. No se notificó a esta persona.');
        continue;
      }
      const { data: sendData, error: sendError } = await supabase.functions.invoke('whatsapp-send', { body: { action: 'SHARE_LINK', companionId: outcome.companionId, token: outcome.token } });
      if (sendError || !sendData?.ok) {
        const responseStatus = sendError && typeof sendError === 'object' && 'context' in sendError
          ? (sendError as { context?: { status?: number } }).context?.status : undefined;
        const queued = sendData?.status === 'REQUESTED' || responseStatus === 503;
        created.push({ label: item.label, status: queued ? 'REQUESTED' : 'FAILED', detail: queued
          ? 'Enlace privado creado y solicitud en cola. Meta no está configurado; no se envió ningún WhatsApp.'
          : 'El enlace se creó, pero Meta rechazó o no confirmó la solicitud.' });
        if (!queued) setError(sendData?.message ?? 'No se pudo solicitar el envío por WhatsApp. No se notificó a esta persona.');
        continue;
      }
      created.push({ label: item.label, status: sendData.status, detail: sendData.status === 'ACCEPTED' ? 'Meta aceptó el mensaje; falta la confirmación de entrega.' : 'La solicitud quedó registrada; revisa el estado en Notificaciones.' });
    }
    setBusy(false);
    setLinks(created);
    if (created.length) onCreated();
  }

  const modal = <div className="modal-backdrop companion-modal-backdrop" role="presentation" onMouseDown={onClose}><div className="modal-card companion-modal" role="dialog" aria-modal="true" aria-labelledby="companion-modal-title" onMouseDown={(event) => event.stopPropagation()}>
    <button className="modal-close" onClick={onClose}><X size={18} /></button>
    <p className="eyebrow">ACOMPAÑAMIENTO INTELIGENTE · PASAJERO</p>
    <h2 id="companion-modal-title">Viaja acompañado con Student Go</h2>
    <div className="companion-trip-context"><strong>{tripLabel}</strong><span>Estás configurando tu propio acompañamiento como pasajero.</span></div>

    {links.length === 0 ? <>
      <p className="modal-lead">Tu abordaje fue confirmado. ¿Quieres compartir tu recorrido con alguien de confianza para que pueda saber si llegaste bien?</p>
      <div className="segmented">{OPTIONS.map((item) => <button key={item.value} className={option === item.value ? 'selected' : ''} onClick={() => setOption(item.value)}>{item.label}</button>)}</div>

      {wantsContacts && <div className="contact-form">
        {contacts === null && <p className="scanner-status">Cargando contactos...</p>}
        {contacts?.length === 0 && <p className="scanner-status">No tienes contactos de emergencia registrados.</p>}
        {contacts?.map((c) => <div className="contact-item" key={c.phone}><div><strong>{c.name}</strong><span>{c.relationship} · {c.phone}</span></div></div>)}
      </div>}

      {wantsPerson && <div className="contact-form">
        <label className="form-label">Nombre completo<input value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre de la persona" /></label>
        <label className="form-label">Relación<input value={form.relationship} maxLength={40} onChange={(e) => setForm({ ...form, relationship: e.target.value })} placeholder="Mamá, amigo, compañera..." /></label>
        <label className="form-label">Celular con lada<input type="tel" value={form.phone} maxLength={20} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+52 222 123 4567" /></label>
        <label className="form-label consent-line"><input type="checkbox" checked={recipientConsent} onChange={(e) => setRecipientConsent(e.target.checked)} /> Confirmo que esta persona autorizó recibir este enlace de Student Go por WhatsApp.</label>
      </div>}

      <label className="form-label"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Autorizo compartir mi ubicación durante este recorrido con las personas seleccionadas.</label>
      <p className="scanner-status">El envío utiliza exclusivamente plantillas aprobadas de WhatsApp Business. La pantalla mostrará el estado que confirme Meta.</p>
      {error && <div className="auth-error">{error}</div>}
      <div className="companion-modal-actions"><button className="secondary-button" disabled={busy} onClick={() => { void saveNowNot(); }}>Ahora no</button><button className="primary-button" disabled={busy || option === 'none' || !consent || (contacts === null && wantsContacts)} onClick={() => { void submit(); }}><UserPlus size={17} /> {busy ? 'Guardando...' : 'Guardar acompañamiento'}</button></div>
    </> : <>
      <p className="modal-lead">Estado confirmado por la integración de WhatsApp Business:</p>
      {links.map((item, index) => <div className="contact-item" key={`${item.label}-${index}`}>
        <div><strong>{item.label}</strong><span>{item.status}: {item.detail}</span></div>
      </div>)}
      <button className="secondary-button wide" onClick={onClose}>Listo</button>
    </>}
  </div></div>;

  // Render on document.body so page layout, scroll containers, and cards can
  // never crop the consent dialog.
  return createPortal(modal, document.body);
}
