import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, UserPlus, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { createCompanion, setCompanionshipPreference, type CompanionInput } from '@/lib/companions';

type Option = 'contacts' | 'person' | 'both' | 'none';
type ContactRow = { name: string; relationship: string; phone: string; whatsapp_consent_at: string | null };
type CreatedLink = {
  label: string;
  status: string;
  detail: string;
  link?: string;
  phone?: string;
  companionId?: string;
};

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
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);

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
    const selection = option === 'contacts' ? 'EMERGENCY_CONTACTS' : option === 'person' ? 'WAITING_PERSON' : 'BOTH';
    const preference = await setCompanionshipPreference(tripId, selection, true);
    if (!preference.ok) { setBusy(false); setError(preference.message); return; }
    const inputs: { label: string; input: CompanionInput }[] = [];
    if (wantsContacts) contacts?.forEach((c) => inputs.push({ label: c.name, input: { name: c.name, relationship: c.relationship, phone: c.phone, source: 'EMERGENCY_CONTACT', locationConsent: consent, whatsappConsent: !!c.whatsapp_consent_at } }));
    if (wantsPerson) inputs.push({ label: form.name.trim(), input: { name: form.name.trim(), relationship: form.relationship.trim(), phone: form.phone.replace(/[\s()-]/g, ''), source: 'COMPANION', locationConsent: consent, whatsappConsent: recipientConsent } });

    const created: CreatedLink[] = [];
    const seenPhones = new Set<string>();
    for (const item of inputs) {
      const normalizedPhone = item.input.phone.replace(/\D/g, '');
      if (seenPhones.has(normalizedPhone)) {
        created.push({ label: item.label, status: 'DUPLICADO', detail: 'Este número ya fue incluido para este viaje.' });
        continue;
      }
      seenPhones.add(normalizedPhone);
      const outcome = await createCompanion(tripRequestId, item.input);
      if (!outcome.ok) { created.push({ label: item.label, status: 'NO_CREADO', detail: outcome.message }); continue; }
      created.push({
        label: item.label,
        status: 'LISTO_PARA_COMPARTIR',
        detail: 'Enlace privado creado. El seguimiento comenzará cuando el viaje esté EN CURSO y autorices la ubicación del navegador.',
        link: outcome.link,
        phone: item.input.phone,
        companionId: outcome.companionId,
      });
    }
    setBusy(false);
    setLinks(created);
    if (created.length) onCreated();
  }

  function linkKey(item: CreatedLink) {
    return item.companionId ?? item.link ?? `${item.label}-${item.phone ?? ''}`;
  }

  async function copySecureLink(item: CreatedLink) {
    if (!item.link) return;
    try {
      await navigator.clipboard.writeText(item.link);
      setCopiedLinkId(linkKey(item));
    } catch {
      setError('No pudimos copiar el enlace. Puedes seleccionarlo y copiarlo manualmente.');
    }
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
      <p className="scanner-status">El enlace se creará solo con tu consentimiento. Después podrás copiarlo y compartirlo únicamente con las personas autorizadas.</p>
      {error && <div className="auth-error">{error}</div>}
      <div className="companion-modal-actions"><button className="secondary-button" disabled={busy} onClick={() => { void saveNowNot(); }}>Ahora no</button><button className="primary-button" disabled={busy || option === 'none' || !consent || (contacts === null && wantsContacts)} onClick={() => { void submit(); }}><UserPlus size={17} /> {busy ? 'Guardando...' : 'Guardar acompañamiento'}</button></div>
    </> : <>
      <p className="modal-lead">Enlaces privados listos para compartir manualmente.</p>
      <p className="scanner-status">No se enviaron mensajes automáticamente. Copia cada enlace y compártelo solo con la persona autorizada.</p>
      {links.map((item, index) => <div className="contact-item companion-created-link" key={linkKey(item) || `${item.label}-${index}`}>
        <div><strong>{item.label}</strong><span>{item.status}: {item.detail}</span>
          {item.link && <><code className="companion-link-preview">{item.link}</code><div className="companion-link-actions">
            <button type="button" className="secondary-button" onClick={() => { void copySecureLink(item); }}><Copy size={15} /> {copiedLinkId === linkKey(item) ? 'Enlace copiado' : 'Copiar enlace seguro'}</button>
          </div></>}
        </div>
      </div>)}
      {error && <div className="auth-error">{error}</div>}
      <button className="secondary-button wide" onClick={onClose}>Listo</button>
    </>}
  </div></div>;

  // Render on document.body so page layout, scroll containers, and cards can
  // never crop the consent dialog.
  return createPortal(modal, document.body);
}
