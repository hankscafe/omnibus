"use client"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Loader2 } from "lucide-react"

interface ConfirmationDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: string
  confirmText?: string
  cancelText?: string
  variant?: "default" | "destructive"
  isLoading?: boolean
}

export function ConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "destructive",
  isLoading = false,
}: ConfirmationDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isLoading && onClose()}>
      <DialogContent className="sm:max-w-[425px] bg-background border-border rounded-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            {variant === "destructive" && <AlertTriangle className="w-5 h-5 text-red-500" />}
            {title}
          </DialogTitle>
          <DialogDescription className="pt-2 text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={isLoading} className="border-border hover:bg-muted text-foreground">
            {cancelText}
          </Button>
          <Button 
            variant={variant} 
            onClick={onConfirm} 
            disabled={isLoading}
            className={variant === "destructive" ? "bg-red-600 hover:bg-red-700 text-white font-bold" : "font-bold bg-primary hover:bg-primary/90 text-primary-foreground"}
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}