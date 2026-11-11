import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Photos } from './images';

type Side = 'front' | 'back';

function PhotoField({ side, file, onSelect }: {
  side: Side;
  file: File | null;
  onSelect: (file: File | null) => void;
}) {
  const label = side === 'front' ? 'Frente' : 'Reverso';
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function selectPhoto(event: ChangeEvent<HTMLInputElement>) {
    const source = event.currentTarget;
    const next = source.files?.[0];
    if (!next) return;
    if (!['image/jpeg', 'image/png'].includes(next.type) || next.size > 8 * 1024 * 1024) {
      source.value = '';
      setMessage('Elige una imagen JPG o PNG de hasta 8 MB.');
      return;
    }
    const other = source === camera.current ? input.current : camera.current;
    if (other) other.value = '';
    setMessage('');
    onSelect(next);
  }

  function clearSelection() {
    if (input.current) input.current.value = '';
    if (camera.current) camera.current.value = '';
    setMessage('');
    onSelect(null);
    input.current?.focus();
  }

  return <div style={{ minWidth: 0, marginBlock: 12 }}>
    <label>
      {label}
      <input ref={input} type="file" accept="image/jpeg,image/png" required={!file}
        onChange={selectPhoto} />
    </label>
    <input ref={camera} hidden type="file" accept="image/*" capture="environment" onChange={selectPhoto} />
    <button type="button" className="small-button" onClick={() => camera.current?.click()}>
      Tomar foto del {label.toLowerCase()}
    </button>
    {file && preview && <figure style={{ margin: '8px 0' }}>
      <img src={preview} alt={'Vista previa del ' + label.toLowerCase()} style={{
        display: 'block', width: '100%', maxHeight: 220, objectFit: 'contain',
        background: '#f3f4fa', borderRadius: 8,
      }} onError={() => {
        if (input.current) input.current.value = '';
        if (camera.current) camera.current.value = '';
        setMessage('No pudimos abrir esta imagen. Selecciona otra foto.');
        onSelect(null);
      }} />
      <figcaption style={{ overflowWrap: 'anywhere', marginBlock: 6 }}>{file.name}</figcaption>
      <button type="button" className="small-button" onClick={() => input.current?.click()}>
        Cambiar foto del {label.toLowerCase()}
      </button>{' '}
      <button type="button" className="small-button" onClick={clearSelection}>
        Quitar foto del {label.toLowerCase()}
      </button>
    </figure>}
    {message && <p role="alert">{message}</p>}
  </div>;
}

export default function CredentialFields({ value, onChange }: { value: Photos; onChange: (next: Photos) => void }) {
  return <fieldset className="signup-emergency-contacts">
    <legend>Credencial de estudiante</legend>
    <p>Elige o toma una foto del frente y otra del reverso de tu credencial.</p>
    {(['front', 'back'] as const).map(side =>
      <PhotoField key={side} side={side} file={value[side]} onSelect={file => onChange({ ...value, [side]: file })} />
    )}
    <label className="consent-line"><input type="checkbox" required checked={value.consent}
      onChange={event => onChange({ ...value, consent: event.target.checked })} />
      Acepto que StudentGo envíe estas fotos a Google Gemini para leer los datos de mi credencial y que un administrador revise las imágenes y el QR.
    </label>
  </fieldset>;
}
