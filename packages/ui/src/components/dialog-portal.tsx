"use client";

import { IconLoader2 } from "@tabler/icons-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { Button, type ButtonVariants } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

type ConfirmDialogState = {
  cancelText?: string;
  confirmText?: string;
  confirmVariant?: ButtonVariants["variant"];
  description?: ReactNode;
  onConfirm: () => unknown | Promise<unknown>;
  open: boolean;
  title: ReactNode;
  titleClassName?: string;
};

const initialConfirmDialogState: ConfirmDialogState = {
  onConfirm: () => undefined,
  open: false,
  title: "",
};
let confirmDialogState = initialConfirmDialogState;
const confirmDialogListeners = new Set<() => void>();

export function DialogPortal() {
  const {
    cancelText = "Cancel",
    confirmText = "Continue",
    confirmVariant,
    description,
    onConfirm,
    open,
    title,
    titleClassName,
  } = useConfirmDialogState();
  const [loading, setLoading] = useState(false);

  function confirm() {
    setLoading(true);
    Promise.resolve(onConfirm())
      .then(() => closeConfirmDialog())
      .catch((error: unknown) => {
        console.error(error);
      })
      .finally(() => setLoading(false));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeConfirmDialog();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className={titleClassName}>{title}</DialogTitle>
          {description !== undefined && (
            <DialogDescription>{description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button disabled={loading} type="button" onClick={closeConfirmDialog}>
            {cancelText}
          </Button>
          <Button
            disabled={loading}
            type="button"
            variant={confirmVariant}
            onClick={confirm}
          >
            {loading && (
              <IconLoader2 aria-hidden="true" className="animate-spin" />
            )}
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function openConfirmDialog(input: Omit<ConfirmDialogState, "open">) {
  confirmDialogState = {
    ...input,
    open: true,
  };
  emitConfirmDialogChange();
}

function closeConfirmDialog() {
  confirmDialogState = {
    ...confirmDialogState,
    open: false,
  };
  emitConfirmDialogChange();
}

function useConfirmDialogState() {
  return useSyncExternalStore(
    subscribeConfirmDialog,
    getConfirmDialogState,
    getConfirmDialogState,
  );
}

function getConfirmDialogState() {
  return confirmDialogState;
}

function subscribeConfirmDialog(listener: () => void) {
  confirmDialogListeners.add(listener);
  return () => {
    confirmDialogListeners.delete(listener);
  };
}

function emitConfirmDialogChange() {
  for (const listener of confirmDialogListeners) {
    listener();
  }
}
