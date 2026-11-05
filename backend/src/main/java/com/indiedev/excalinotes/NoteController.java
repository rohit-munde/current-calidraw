package com.indiedev.excalinotes;

import com.indiedev.excalinotes.Dtos.*;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/notes")
public class NoteController {

    private final NoteRepository notes;

    public NoteController(NoteRepository notes) {
        this.notes = notes;
    }

    @GetMapping("/{id}")
    @Transactional(readOnly = true)
    public NoteResponse get(@PathVariable Long id) {
        return NoteResponse.of(find(id));
    }

    // Body is the raw Excalidraw scene JSON, stored as-is.
    @PutMapping(value = "/{id}/scene", consumes = "application/json")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void saveScene(@PathVariable Long id, @RequestBody String scene) {
        find(id).setScene(scene);
    }

    @PatchMapping("/{id}")
    @Transactional
    public NoteResponse rename(@PathVariable Long id, @RequestBody NameRequest req) {
        Note note = find(id);
        note.setTitle(TopicController.requireName(req.name()));
        return NoteResponse.of(note);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        notes.deleteById(id);
    }

    private Note find(Long id) {
        return notes.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Note not found"));
    }
}
