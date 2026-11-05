import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { Bell, Car, Shield } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { NotificationItem } from '@/lib/safety';

type Filter = 'all' | 'unread' | 'trips' | 'security';
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'unread', label: 'No leídas' },
  { value: 'trips', label: 'Viajes' },
  { value: 'security', label: 'Seguridad' },
];

export default function NotificationsView({ user, onOpen, onChanged }: { user: User; onOpen: (target: 'trips' | 'security') => void; onChanged: () => void }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    const { data } = await supabase.from('notifications').select('id, title, message, type, target, reference_id, read_at, created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100);
    setItems((data ?? []) as NotificationItem[]);
  }, [user.id]);

  useEffect(() => { void load(); }, [load]);

  async function open(item: NotificationItem) {
    if (!item.read_at) {
      await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', item.id);
      void load();
      onChanged();
    }
    if (item.target) onOpen(item.target);
  }

  const visible = items.filter((item) => {
    if (filter === 'unread') return !item.read_at;
    if (filter === 'trips') return item.type === 'TRIP';
    if (filter === 'security') return item.type === 'SAFETY';
    return true;
  });

  return <div className="page-wrap">
    <div className="page-title"><div><p className="eyebrow">AVISOS</p><h1>Centro de notificaciones</h1><p>Eventos reales de tus viajes y de tu seguridad</p></div></div>
    <div className="segmented">{FILTERS.map((f) => <button key={f.value} className={filter === f.value ? 'active' : ''} onClick={() => setFilter(f.value)}>{f.label}</button>)}</div>
    {visible.length === 0 && <div className="empty-panel"><Bell size={28} /><p>No tienes notificaciones por el momento</p></div>}
    <div className="notifications">
      {visible.map((item) => <button key={item.id} className="notification" style={{ textAlign: 'left', opacity: item.read_at ? 0.7 : 1 }} onClick={() => { void open(item); }}>
        <div className={`notification-icon ${item.type === 'SAFETY' ? 'warning' : 'blue'}`}>{item.type === 'SAFETY' ? <Shield size={18} /> : <Car size={18} />}</div>
        <div><strong>{item.title}</strong><p>{item.message}</p><span>{new Date(item.created_at).toLocaleString('es-MX')}{item.read_at ? '' : ' · No leída'}</span></div>
      </button>)}
    </div>
  </div>;
}
