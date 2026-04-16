import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/format';
import type { SupplierDetail } from './use-suppliers';
import {
  useAddSupplierContact,
  useAddSupplierAddress,
  useAddSupplierNote,
  useDeleteSupplierContact,
  useDeleteSupplierAddress,
} from './use-suppliers';

export function SupplierContactsTab({ supplier }: { supplier: SupplierDetail }) {
  const { toast } = useToast();
  const contacts = supplier.contacts ?? [];
  const [showAdd, setShowAdd] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<string | null>(null);
  const addMutation = useAddSupplierContact();
  const deleteMutation = useDeleteSupplierContact();
  const [form, setForm] = React.useState({ name: '', jobTitle: '', email: '', mobile: '' });

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}
        </p>
        <Button size="sm" onClick={() => setShowAdd((s) => !s)}>
          <Plus className="h-4 w-4" /> {showAdd ? 'Close' : 'Add contact'}
        </Button>
      </div>
      {showAdd && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              {(['name', 'jobTitle', 'email', 'mobile'] as const).map((f) => (
                <div className="space-y-1" key={f}>
                  <Label htmlFor={`sc-${f}`}>{f[0]!.toUpperCase() + f.slice(1)}</Label>
                  <Input
                    id={`sc-${f}`}
                    value={form[f]}
                    onChange={(e) => setForm((x) => ({ ...x, [f]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  await addMutation.mutateAsync({
                    supplierId: supplier.id,
                    input: {
                      name: form.name || undefined,
                      jobTitle: form.jobTitle || undefined,
                      email: form.email || undefined,
                      mobile: form.mobile || undefined,
                    },
                  });
                  toast({ title: 'Contact added' });
                  setForm({ name: '', jobTitle: '', email: '', mobile: '' });
                  setShowAdd(false);
                }}
                disabled={addMutation.isPending}
              >
                {addMutation.isPending ? 'Adding…' : 'Add contact'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {contacts.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">Job</th>
                  <th className="px-4 py-2 text-left font-medium">Email</th>
                  <th className="px-4 py-2 text-left font-medium">Mobile</th>
                  <th className="w-12 px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-4 py-2">{c.name ?? '—'}</td>
                    <td className="px-4 py-2">{c.jobTitle ?? '—'}</td>
                    <td className="px-4 py-2">{c.email ?? '—'}</td>
                    <td className="px-4 py-2">{c.mobile ?? '—'}</td>
                    <td className="px-4 py-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setToDelete(c.id)}
                        aria-label={`Delete contact ${c.name ?? ''}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete contact?"
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteMutation.mutateAsync({ supplierId: supplier.id, contactId: toDelete });
          toast({ title: 'Contact deleted' });
          setToDelete(null);
        }}
      />
    </div>
  );
}

export function SupplierAddressesTab({ supplier }: { supplier: SupplierDetail }) {
  const { toast } = useToast();
  const addresses = supplier.addresses ?? [];
  const addMutation = useAddSupplierAddress();
  const deleteMutation = useDeleteSupplierAddress();
  const [showAdd, setShowAdd] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    line1: '',
    line2: '',
    city: '',
    postCode: '',
    country: '',
    addressType: 'INVOICE' as 'INVOICE' | 'WAREHOUSE',
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {addresses.length} {addresses.length === 1 ? 'address' : 'addresses'}
        </p>
        <Button size="sm" onClick={() => setShowAdd((s) => !s)}>
          <Plus className="h-4 w-4" /> {showAdd ? 'Close' : 'Add address'}
        </Button>
      </div>
      {showAdd && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <Input
              placeholder="Line 1"
              value={form.line1}
              onChange={(e) => setForm((f) => ({ ...f, line1: e.target.value }))}
            />
            <Input
              placeholder="Line 2"
              value={form.line2}
              onChange={(e) => setForm((f) => ({ ...f, line2: e.target.value }))}
            />
            <div className="grid gap-3 md:grid-cols-3">
              <Input
                placeholder="City"
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
              />
              <Input
                placeholder="Postcode"
                value={form.postCode}
                onChange={(e) => setForm((f) => ({ ...f, postCode: e.target.value }))}
              />
              <Input
                placeholder="Country"
                value={form.country}
                onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  await addMutation.mutateAsync({
                    supplierId: supplier.id,
                    input: {
                      line1: form.line1 || undefined,
                      line2: form.line2 || undefined,
                      city: form.city || undefined,
                      postCode: form.postCode || undefined,
                      country: form.country || undefined,
                      addressType: form.addressType,
                    },
                  });
                  toast({ title: 'Address added' });
                  setForm({
                    line1: '',
                    line2: '',
                    city: '',
                    postCode: '',
                    country: '',
                    addressType: 'INVOICE',
                  });
                  setShowAdd(false);
                }}
                disabled={addMutation.isPending}
              >
                Add address
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {addresses.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {addresses.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex items-start justify-between p-4">
                <div className="text-sm">
                  <p className="font-medium text-xs text-[var(--color-muted-foreground)]">
                    {a.addressType}
                  </p>
                  {a.line1 && <div>{a.line1}</div>}
                  {a.line2 && <div>{a.line2}</div>}
                  {(a.city || a.postCode) && (
                    <div>
                      {a.city} {a.postCode}
                    </div>
                  )}
                  {a.country && <div>{a.country}</div>}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setToDelete(a.id)}
                  aria-label="Delete address"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete address?"
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteMutation.mutateAsync({ supplierId: supplier.id, addressId: toDelete });
          toast({ title: 'Address deleted' });
          setToDelete(null);
        }}
      />
    </div>
  );
}

export function SupplierNotesTab({ supplier }: { supplier: SupplierDetail }) {
  const { toast } = useToast();
  const notes = supplier.notes ?? [];
  const addMutation = useAddSupplierNote();
  const [noteText, setNoteText] = React.useState('');

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <Label htmlFor="note">Add note</Label>
          <Textarea
            id="note"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={3}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={async () => {
                if (!noteText.trim()) return;
                await addMutation.mutateAsync({
                  supplierId: supplier.id,
                  input: { note: noteText },
                });
                toast({ title: 'Note added' });
                setNoteText('');
              }}
              disabled={addMutation.isPending || !noteText.trim()}
            >
              Add note
            </Button>
          </div>
        </CardContent>
      </Card>
      {notes.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No notes yet.</p>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <Card key={n.id}>
              <CardContent className="p-4">
                <p className="whitespace-pre-wrap text-sm">{n.note}</p>
                <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                  {formatDate(n.createdAt)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
