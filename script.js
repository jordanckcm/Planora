const pages = document.getElementById("pages");
const dots = document.querySelectorAll(".dot");
const nextButton = document.getElementById("nextButton");

let currentPage = 0;

const totalPages = dots.length;


// UPDATE PAGE

function updatePage() {

    pages.style.transform =
        `translateX(-${currentPage * 100}%)`;


    dots.forEach((dot, index) => {

        dot.classList.toggle(
            "active",
            index === currentPage
        );

    });


    if (currentPage === totalPages - 1) {

        nextButton.textContent = "GET STARTED →";

    } else {

        nextButton.textContent = "NEXT →";

    }

}


// NEXT

nextButton.addEventListener("click", () => {

    if (currentPage < totalPages - 1) {

        currentPage++;

        updatePage();

    } else {

        window.location.href = "login.html";

    }

});


// SWIPE

let startX = 0;

pages.addEventListener("touchstart", (event) => {

    startX = event.touches[0].clientX;

});


pages.addEventListener("touchend", (event) => {

    const endX = event.changedTouches[0].clientX;

    const difference = startX - endX;


    // Swipe left

    if (difference > 50) {

        if (currentPage < totalPages - 1) {

            currentPage++;

            updatePage();

        }

    }


    // Swipe right

    if (difference < -50) {

        if (currentPage > 0) {

            currentPage--;

            updatePage();

        }

    }

});


updatePage();