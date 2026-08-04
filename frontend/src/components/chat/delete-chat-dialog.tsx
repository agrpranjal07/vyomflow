import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ChatDTO } from "@/contracts/chats";

export function DeleteChatDialog({
  chat,
  onCancel,
  onConfirm,
}: {
  chat: ChatDTO | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={chat !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete chat?</DialogTitle>
          <DialogDescription>
            {chat && (
              <>
                &ldquo;{chat.title}&rdquo; will be removed from your chat list. This can&rsquo;t be undone from here.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
