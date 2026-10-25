package dev.voidrun.api.problems;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.common.Language;
import java.util.Arrays;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** What the editor needs before the first keystroke. */
@RestController
@RequestMapping("/api/v1")
public class MetaController {

    public record LanguageDto(String id, String displayName, String monacoId, String starterCode) {}

    private final VoidRunProperties.Limits limits;

    public MetaController(VoidRunProperties props) {
        this.limits = props.limits();
    }

    @GetMapping("/languages")
    List<LanguageDto> languages() {
        return Arrays.stream(Language.values())
                .map(l -> new LanguageDto(l.id(), l.displayName(), l.monacoId(), l.starterCode()))
                .toList();
    }

    @GetMapping("/limits")
    VoidRunProperties.Limits limits() {
        return limits;
    }
}
