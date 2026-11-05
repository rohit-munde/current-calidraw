package com.indiedev.excalinotes;

import com.indiedev.excalinotes.Dtos.*;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

@RestController
@RequestMapping("/api/topics")
public class TopicController {

    private final TopicRepository topics;
    private final NoteRepository notes;

    public TopicController(TopicRepository topics, NoteRepository notes) {
        this.topics = topics;
        this.notes = notes;
    }

    @GetMapping
    public List<TopicResponse> list() {
        return topics.findAllByOrderByNameAsc().stream().map(TopicResponse::of).toList();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public TopicResponse create(@RequestBody NameRequest req) {
        String name = requireName(req.name());
        if (topics.existsByName(name)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Topic already exists");
        }
        return TopicResponse.of(topics.save(new Topic(name)));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void delete(@PathVariable Long id) {
        notes.deleteAllByTopicId(id);
        topics.deleteById(id);
    }

    @GetMapping("/{id}/notes")
    public List<NoteRepository.NoteSummary> listNotes(@PathVariable Long id) {
        return notes.findByTopicIdOrderByUpdatedAtDesc(id);
    }

    @PostMapping("/{id}/notes")
    @ResponseStatus(HttpStatus.CREATED)
    public NoteResponse createNote(@PathVariable Long id, @RequestBody NameRequest req) {
        Topic topic = topics.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Topic not found"));
        return NoteResponse.of(notes.save(new Note(topic, requireName(req.name()))));
    }

    static String requireName(String name) {
        if (name == null || name.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Name is required");
        }
        return name.trim();
    }
}
