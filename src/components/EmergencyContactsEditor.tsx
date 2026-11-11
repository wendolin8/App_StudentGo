import { useCallback, useEffect, useState } from 'react';
import { Check, Contact, Plus } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type EmergencyContact = { id: string; name: string; relationship: string; phone: string; notification_method: string; whatsapp_consent_at: string | null };
type Draft = { name: string; relationship: string; phone: string; whatsappConsent: boolean };
const emptyDraft: Draft = { name: '', relationship: '', phone: '', whatsappConsent: false };

export default function EmergencyContactsEditor({ userId }: { userId: string }) {
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [alertsConsent, setAlertsConsent] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ data, error }, { data: profile }] = await Promise.all([
      supabase.from('emergency_contacts').select('id, name, relationship, phone, notification_method, whatsapp_consent_at').eq('user_id', userId).order('created_at'),
      supabase.from('profiles').select('whatsapp_alerts_consent_at').eq('id', userId).maybeSingle(),
    ]);
    if (error) setMessage('No pudimos cargar tus contactos de emergencia.');
    else setContacts((data ?? []) as EmergencyContact[]);
    setAlertsConsent(!!profile?.whatsapp_alerts_consent_at);
    setLoading(false);
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  function reset(): void { setDraft(emptyDraft); setEditingId(null); }

  async function updateAlertsConsent(enabled: boolean): Promise<void> {
    setConsentBusy(true);
    const { data, error } = await supabase.rpc('set_whatsapp_alert_consent', { p_enabled: enabled });
    setConsentBusy(false);
    if (error || data !== true) { setMessage('No pudimos actualizar tu consentimiento.'); return; }
    setAlertsConsent(enabled);
    setMessage(enabled ? 'Consentimiento de WhatsApp activado.' : 'Consentimiento revocado. Los enlaces activos fueron revocados.');
  }

  async function save(): Promise<void> {
    const phone = draft.phone.replace(/[\s()-]/g, '');
    if (!draft.name.trim() || !draft.relationship.trim() || !/^\+[1-9][0-9]{9,14}$/.test(phone)) {
      setMessage('Completa nombre, parentesco y celular internacional con + y lada, por ejemplo +522221234567.');
      return;
    }
    if (!draft.whatsappConsent) { setMessage('Confirma que la persona autorizó recibir mensajes de Student Go por WhatsApp.'); return; }
    if (!editingId && contacts.length >= 2) { setMessage('Puedes registrar hasta dos contactos.'); return; }
    setBusy(true); setMessage('');
    const values = { name: draft.name.trim(), relationship: draft.relationship.trim(), phone, notification_method: 'WHATSAPP', whatsapp_consent_at: new Date().toISOString() };
    const query = editingId
      ? supabase.from('emergency_contacts').update(values).eq('id', editingId).eq('user_id', userId)
      : supabase.from('emergency_contacts').insert({ ...values, user_id: userId });
    const { error } = await query;
    setBusy(false);
    if (error) { setMessage(error.message.includes('MAX_EMERGENCY_CONTACTS') ? 'Ya tienes dos contactos registrados.' : 'No pudimos guardar el contacto. Revisa que el teléfono no esté duplicado.'); return; }
    reset(); setMessage('Contacto guardado.'); await load();
  }

  function edit(contact: EmergencyContact): void {
    setEditingId(contact.id);
    setDraft({ name: contact.name, relationship: contact.relationship, phone: contact.phone, whatsappConsent: false });
    setMessage('');
  }

  return <section className="sos-section">
    <p className="eyebrow"><Contact size={14} /> CONTACTOS DE EMERGENCIA</p>
    <p>Registra exactamente dos personas con celular internacional. Los avisos externos de seguridad de Student Go usan solo WhatsApp.</p>
    <label className="form-label consent-line"><input type="checkbox" checked={alertsConsent} disabled={consentBusy} onChange={(event) => { void updateAlertsConsent(event.target.checked); }} /> Autorizo a Student Go usar WhatsApp para los destinatarios que yo elija durante Acompañamiento Inteligente. Esto no activa ni modifica mis contactos de emergencia.</label>
    {loading ? <p className="scanner-status">Cargando contactos...</p> : contacts.map((contact) => <div className="contact-item" key={contact.id}>
      <div><strong>{contact.name}</strong><span>{contact.relationship} · WhatsApp · {contact.phone}</span></div>
      <div><button className="small-button" onClick={() => edit(contact)}>Editar</button></div>
    </div>)}
    {!loading && contacts.length < 2 && !editingId && <p className="scanner-status">Te falta registrar {2 - contacts.length} contacto{contacts.length === 0 ? 's' : ''}.</p>}
    {(contacts.length < 2 || editingId) && <div className="contact-form">
      <label className="form-label">Nombre completo<input maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Nombre de tu contacto" /></label>
      <label className="form-label">Parentesco<input maxLength={60} value={draft.relationship} onChange={(event) => setDraft({ ...draft, relationship: event.target.value })} placeholder="Madre, hermano, amistad..." /></label>
      <label className="form-label">Celular con lada<input type="tel" maxLength={20} value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} placeholder="+52 222 123 4567" /></label>
      <label className="form-label consent-line"><input type="checkbox" checked={draft.whatsappConsent} onChange={(event) => setDraft({ ...draft, whatsappConsent: event.target.checked })} /> Confirmo que esta persona autorizó recibir avisos de Student Go por WhatsApp.</label>
      <div className="trip-meta"><button className="primary-button" disabled={busy} onClick={() => { void save(); }}>{editingId ? <Check size={15} /> : <Plus size={15} />}{busy ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Agregar contacto'}</button>{editingId && <button className="secondary-button" onClick={reset}>Cancelar</button>}</div>
    </div>}
    {message && <p className="scanner-status" role="status">{message}</p>}
  </section>;
}
